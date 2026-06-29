/*
 * Copyright 2026 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { TestDatabaseId, TestDatabases } from '@backstage/backend-test-utils';
import { Knex } from 'knex';
import {
  V2DailyTotal,
  V2IngestionLogRow,
  V2UserMetricRow,
  V2UserTeamRow,
} from '@backstage-community/plugin-copilot-common';
import { migrationsDir } from './DatabaseHandler';
import { DatabaseHandlerV2 } from './DatabaseHandlerV2';

jest.setTimeout(60_000);

describe('DatabaseHandlerV2', () => {
  const databases = TestDatabases.create();

  async function createDatabase(databaseId: TestDatabaseId) {
    const knex = await databases.init(databaseId);
    await knex.migrate.latest({ directory: migrationsDir });
    return knex;
  }

  describe.each(databases.eachSupportedId())('database: %s', databaseId => {
    let knex: Knex;
    let handler: DatabaseHandlerV2;

    // Skip MySQL tests due to known migration issues in earlier migrations.
    if (databaseId.startsWith('MYSQL')) {
      // eslint-disable-next-line jest/no-disabled-tests, jest/expect-expect
      it.skip('tests for MySQL due to pre-existing migration issue', () => {});
      return;
    }

    beforeEach(async () => {
      knex = await createDatabase(databaseId);
      handler = await DatabaseHandlerV2.create({
        database: {
          getClient: async () => knex,
          migrations: { skip: true },
        } as any,
      });
    });

    afterEach(async () => {
      await knex?.destroy();
    });

    it('getMissingDays returns all days when ingestion log is empty', async () => {
      const result = await handler.getMissingDays(
        'organization',
        'org-1',
        '2026-05-01',
        '2026-05-03',
      );

      expect(result).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
    });

    it('getMissingDays skips successful days and returns remaining days', async () => {
      await handler.upsertIngestionLog(
        buildIngestionLog({ day: '2026-05-01', status: 'success' }),
      );
      await handler.upsertIngestionLog(
        buildIngestionLog({ day: '2026-05-03', status: 'success' }),
      );

      const result = await handler.getMissingDays(
        'organization',
        'org-1',
        '2026-05-01',
        '2026-05-03',
      );

      expect(result).toEqual(['2026-05-02']);
    });

    it('getMissingDays returns empty array when all days are successful', async () => {
      await handler.upsertIngestionLog(
        buildIngestionLog({ day: '2026-05-01', status: 'success' }),
      );
      await handler.upsertIngestionLog(
        buildIngestionLog({ day: '2026-05-02', status: 'success' }),
      );
      await handler.upsertIngestionLog(
        buildIngestionLog({ day: '2026-05-03', status: 'success' }),
      );

      const result = await handler.getMissingDays(
        'organization',
        'org-1',
        '2026-05-01',
        '2026-05-03',
      );

      expect(result).toEqual([]);
    });

    it('getMissingDays does not skip error days', async () => {
      await handler.upsertIngestionLog(
        buildIngestionLog({ day: '2026-05-01', status: 'success' }),
      );
      await handler.upsertIngestionLog(
        buildIngestionLog({ day: '2026-05-02', status: 'error' }),
      );

      const result = await handler.getMissingDays(
        'organization',
        'org-1',
        '2026-05-01',
        '2026-05-03',
      );

      expect(result).toEqual(['2026-05-02', '2026-05-03']);
    });

    it('getMissingDays only skips success rows with all required components', async () => {
      await handler.upsertIngestionLog(
        buildIngestionLog({
          day: '2026-05-01',
          status: 'success',
          components_loaded: '["totals"]',
        }),
      );
      await handler.upsertIngestionLog(
        buildIngestionLog({
          day: '2026-05-02',
          status: 'success',
          components_loaded: '["totals","users","teams"]',
        }),
      );

      const result = await handler.getMissingDays(
        'organization',
        'org-1',
        '2026-05-01',
        '2026-05-03',
        ['totals', 'users', 'teams'],
      );

      expect(result).toEqual(['2026-05-01', '2026-05-03']);
    });

    it('upsertIngestionLog inserts a new row', async () => {
      await handler.upsertIngestionLog(
        buildIngestionLog({
          day: '2026-05-10',
          status: 'success',
          components_loaded: '["totals","users"]',
        }),
      );

      const logs = await handler.getIngestionLog('organization', 'org-1');
      expect(logs).toHaveLength(1);
      expect(normalizeDate(logs[0].day)).toBe('2026-05-10');
      expect(logs[0].status).toBe('success');
      expect(logs[0].components_loaded).toBe('["totals","users"]');
    });

    it('upsertIngestionLog updates existing row on conflict', async () => {
      await handler.upsertIngestionLog(
        buildIngestionLog({ day: '2026-05-11', status: 'success' }),
      );

      await handler.upsertIngestionLog(
        buildIngestionLog({
          day: '2026-05-11',
          status: 'error',
          components_loaded: '["totals"]',
          error_message: 'download failed',
          source: 'backfill',
        }),
      );

      const logs = await handler.getIngestionLog('organization', 'org-1');
      expect(logs).toHaveLength(1);
      expect(logs[0].status).toBe('error');
      expect(logs[0].components_loaded).toBe('["totals"]');
      expect(logs[0].error_message).toBe('download failed');
      expect(logs[0].source).toBe('backfill');
    });

    it('insertDailyTotals is idempotent with conflict ignore', async () => {
      const row = buildDailyTotal({ day: '2026-05-20', team_slug: '' });

      await handler.insertDailyTotals([row]);
      await handler.insertDailyTotals([row]);

      const rows = await knex('copilot_daily_totals').where({
        day: '2026-05-20',
        metrics_type: 'organization',
        entity_id: 'org-1',
        team_slug: '',
      });

      expect(rows).toHaveLength(1);
    });

    it('getDailyTotals filters by date range and team', async () => {
      await handler.insertDailyTotals([
        buildDailyTotal({ day: '2026-05-01', team_slug: 'team-a' }),
        buildDailyTotal({ day: '2026-05-02', team_slug: 'team-a' }),
        buildDailyTotal({ day: '2026-05-02', team_slug: 'team-b' }),
        buildDailyTotal({ day: '2026-05-04', team_slug: 'team-a' }),
      ]);

      const rows = await handler.getDailyTotals(
        'organization',
        'org-1',
        '2026-05-01',
        '2026-05-03',
        'team-a',
      );

      expect(rows).toHaveLength(2);
      expect(rows.map(r => normalizeDate(r.day))).toEqual([
        '2026-05-01',
        '2026-05-02',
      ]);
      expect(rows.every(r => r.team_slug === 'team-a')).toBe(true);
    });

    it('getPeriodRange returns min/max day from daily totals', async () => {
      await handler.insertDailyTotals([
        buildDailyTotal({ day: '2026-05-03', team_slug: '' }),
        buildDailyTotal({ day: '2026-05-01', team_slug: '' }),
        buildDailyTotal({ day: '2026-05-02', team_slug: '' }),
      ]);

      const range = await handler.getPeriodRange('organization', 'org-1');

      expect(range).toEqual({
        minDate: '2026-05-01',
        maxDate: '2026-05-03',
      });
    });

    it('getTeams returns only team slugs with 5 or more distinct members', async () => {
      // 'alpha' has 5 members — should be returned
      await handler.insertUserTeams([
        buildUserTeam({ team_slug: 'alpha', user_id: 1, user_login: 'u1' }),
        buildUserTeam({ team_slug: 'alpha', user_id: 2, user_login: 'u2' }),
        buildUserTeam({ team_slug: 'alpha', user_id: 3, user_login: 'u3' }),
        buildUserTeam({ team_slug: 'alpha', user_id: 4, user_login: 'u4' }),
        buildUserTeam({ team_slug: 'alpha', user_id: 5, user_login: 'u5' }),
        // 'beta' has only 4 members — should be excluded
        buildUserTeam({ team_slug: 'beta', user_id: 1, user_login: 'u1' }),
        buildUserTeam({ team_slug: 'beta', user_id: 2, user_login: 'u2' }),
        buildUserTeam({ team_slug: 'beta', user_id: 3, user_login: 'u3' }),
        buildUserTeam({ team_slug: 'beta', user_id: 4, user_login: 'u4' }),
      ]);

      const teams = await handler.getTeams(
        'organization',
        'org-1',
        '2026-05-01',
        '2026-05-03',
      );

      expect(teams).toEqual(['alpha']);
    });

    it('getTeams counts distinct members across days, not per-day rows', async () => {
      // same user appears on two days in 'gamma' — should still count as 1 member
      await handler.insertUserTeams([
        buildUserTeam({
          team_slug: 'gamma',
          user_id: 1,
          user_login: 'u1',
          day: '2026-05-01',
        }),
        buildUserTeam({
          team_slug: 'gamma',
          user_id: 1,
          user_login: 'u1',
          day: '2026-05-02',
        }),
        buildUserTeam({
          team_slug: 'gamma',
          user_id: 2,
          user_login: 'u2',
          day: '2026-05-01',
        }),
        buildUserTeam({
          team_slug: 'gamma',
          user_id: 3,
          user_login: 'u3',
          day: '2026-05-01',
        }),
        buildUserTeam({
          team_slug: 'gamma',
          user_id: 4,
          user_login: 'u4',
          day: '2026-05-01',
        }),
        // only 4 distinct users — should be excluded
      ]);

      const teams = await handler.getTeams(
        'organization',
        'org-1',
        '2026-05-01',
        '2026-05-02',
      );

      expect(teams).toEqual([]);
    });

    it('getDashboardData returns all chart data in a single call', async () => {
      await handler.insertDailyTotals([
        buildDailyTotal({ day: '2026-05-01', team_slug: '' }),
        buildDailyTotal({ day: '2026-05-02', team_slug: '' }),
      ]);

      const result = await handler.getDashboardData(
        'organization',
        'org-1',
        '2026-05-01',
        '2026-05-02',
      );

      expect(result).toHaveProperty('daily');
      expect(result).toHaveProperty('byFeature');
      expect(result).toHaveProperty('byLanguage');
      expect(result).toHaveProperty('byModelFeature');
      expect(result).toHaveProperty('byLanguageModel');
      expect(result).toHaveProperty('prMetrics');
      expect(result.daily).toHaveLength(2);
    });

    it('getDailyTotals computes rolling weekly/monthly active users for teams', async () => {
      const D1 = '2026-05-01'; // May 1
      const D7 = '2026-05-07'; // May 7  (D1 + 6 days, last day of D1's weekly window)
      const D8 = '2026-05-08'; // May 8  (D1 + 7 days, first day outside D1's weekly window)

      // Insert user-team memberships:
      //   D1: users 1 and 2 are in team 'alpha'
      //   D7: users 2 and 3 are in team 'alpha'
      //   D8: users 3 and 4 are in team 'alpha'
      await handler.insertUserTeams([
        buildUserTeam({
          day: D1,
          user_id: 1,
          user_login: 'u1',
          team_slug: 'alpha',
        }),
        buildUserTeam({
          day: D1,
          user_id: 2,
          user_login: 'u2',
          team_slug: 'alpha',
        }),
        buildUserTeam({
          day: D7,
          user_id: 2,
          user_login: 'u2',
          team_slug: 'alpha',
        }),
        buildUserTeam({
          day: D7,
          user_id: 3,
          user_login: 'u3',
          team_slug: 'alpha',
        }),
        buildUserTeam({
          day: D8,
          user_id: 3,
          user_login: 'u3',
          team_slug: 'alpha',
        }),
        buildUserTeam({
          day: D8,
          user_id: 4,
          user_login: 'u4',
          team_slug: 'alpha',
        }),
      ]);

      // Insert user metrics (daily activity):
      //   D1: user 1 is active
      //   D7: users 2 and 3 are active
      //   D8: user 4 is active
      await handler.insertUserMetrics([
        buildUserMetric({ day: D1, user_id: 1, user_login: 'u1' }),
        buildUserMetric({ day: D7, user_id: 2, user_login: 'u2' }),
        buildUserMetric({ day: D7, user_id: 3, user_login: 'u3' }),
        buildUserMetric({ day: D8, user_id: 4, user_login: 'u4' }),
      ]);

      // Insert daily totals for team 'alpha' with null weekly/monthly values
      // (as stored by the ingestion pipeline — rolling windows are not from the API)
      await handler.insertDailyTotals([
        buildDailyTotal({
          day: D1,
          team_slug: 'alpha',
          daily_active_users: 1,
          weekly_active_users: undefined,
          monthly_active_users: undefined,
        }),
        buildDailyTotal({
          day: D7,
          team_slug: 'alpha',
          daily_active_users: 2,
          weekly_active_users: undefined,
          monthly_active_users: undefined,
        }),
        buildDailyTotal({
          day: D8,
          team_slug: 'alpha',
          daily_active_users: 1,
          weekly_active_users: undefined,
          monthly_active_users: undefined,
        }),
      ]);

      const rows = await handler.getDailyTotals(
        'organization',
        'org-1',
        D1,
        D8,
        'alpha',
      );

      expect(rows).toHaveLength(3);

      // D1 – weekly window [Apr 25, May 1]: only D1 has data
      //   D1 team ∩ D1 active = {1,2} ∩ {1} = {1}  → weekly = 1
      //   monthly window [Apr 3, May 1]: same days in range → monthly = 1
      expect(rows[0].weekly_active_users).toBe(1);
      expect(rows[0].monthly_active_users).toBe(1);

      // D7 – weekly window [May 1, May 7]:
      //   D1 team ∩ D1 active = {1,2} ∩ {1} = {1}
      //   D7 team ∩ D7 active = {2,3} ∩ {2,3} = {2,3}
      //   union → {1,2,3}  → weekly = 3
      //   monthly window [Apr 9, May 7]: same days fall in range → monthly = 3
      expect(rows[1].weekly_active_users).toBe(3);
      expect(rows[1].monthly_active_users).toBe(3);

      // D8 – weekly window [May 2, May 8]:
      //   D7 team ∩ D7 active = {2,3} ∩ {2,3} = {2,3}
      //   D8 team ∩ D8 active = {3,4} ∩ {4} = {4}
      //   union → {2,3,4}  → weekly = 3
      //   monthly window [Apr 10, May 8]: D1 also falls in window
      //   D1 team ∩ D1 active = {1}  → union → {1,2,3,4} → monthly = 4
      expect(rows[2].weekly_active_users).toBe(3);
      expect(rows[2].monthly_active_users).toBe(4);
    });
  });
});

function buildIngestionLog(
  overrides: Partial<V2IngestionLogRow> = {},
): V2IngestionLogRow {
  return {
    day: '2026-05-01',
    metrics_type: 'organization',
    entity_id: 'org-1',
    status: 'success',
    components_loaded: '["totals"]',
    source: 'scheduled',
    ...overrides,
  };
}

function buildDailyTotal(overrides: Partial<V2DailyTotal> = {}): V2DailyTotal {
  return {
    day: '2026-05-01',
    metrics_type: 'organization',
    entity_id: 'org-1',
    team_slug: '',
    daily_active_users: 10,
    weekly_active_users: 20,
    monthly_active_users: 30,
    daily_active_cli_users: 4,
    monthly_active_agent_users: 5,
    monthly_active_chat_users: 6,
    code_acceptance_activity_count: 100,
    code_generation_activity_count: 120,
    loc_added_sum: 1000,
    loc_deleted_sum: 500,
    loc_suggested_to_add_sum: 1400,
    loc_suggested_to_delete_sum: 700,
    user_initiated_interaction_count: 33,
    ...overrides,
  };
}

function normalizeDate(day: string | Date): string {
  if (day instanceof Date) {
    return day.toISOString().split('T')[0];
  }

  return /^\d{4}-\d{2}-\d{2}/.exec(day)?.[0] ?? day;
}

function buildUserTeam(overrides: Partial<V2UserTeamRow> = {}): V2UserTeamRow {
  return {
    day: '2026-05-01',
    metrics_type: 'organization',
    entity_id: 'org-1',
    user_id: 1,
    user_login: 'octocat',
    team_id: 100,
    team_slug: 'alpha',
    ...overrides,
  };
}

function buildUserMetric(
  overrides: Partial<V2UserMetricRow> = {},
): V2UserMetricRow {
  return {
    day: '2026-05-01',
    metrics_type: 'organization',
    entity_id: 'org-1',
    user_id: 1,
    user_login: 'octocat',
    used_agent: false,
    used_chat: false,
    used_cli: true,
    code_acceptance_activity_count: 1,
    code_generation_activity_count: 2,
    loc_added_sum: 10,
    loc_deleted_sum: 3,
    loc_suggested_to_add_sum: 12,
    loc_suggested_to_delete_sum: 4,
    user_initiated_interaction_count: 5,
    ...overrides,
  };
}
