/*
 * Copyright 2024 The Backstage Authors
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
import {
  coreServices,
  createBackendPlugin,
  createExtensionPoint,
} from '@backstage/backend-plugin-api';
import { createRouterFromConfig } from './service/router';
import {
  CopilotCredentialsProvider,
  DefaultCopilotCredentialsProvider,
} from './utils/CopilotCredentialsProvider';

export interface CopilotExtensionPoint {
  useCredentialsProvider(provider: CopilotCredentialsProvider): void;
}

export const copilotExtensionPoint =
  createExtensionPoint<CopilotExtensionPoint>({
    id: 'copliot.credentials',
  });

/**
 * Backend plugin for Copilot.
 *
 * @public
 */
export const copilotPlugin = createBackendPlugin({
  pluginId: 'copilot',
  register(env) {
    let credentialsProvider: CopilotCredentialsProvider;
    env.registerExtensionPoint(copilotExtensionPoint, {
      useCredentialsProvider(provider: CopilotCredentialsProvider) {
        credentialsProvider = provider;
      },
    });

    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
        database: coreServices.database,
        scheduler: coreServices.scheduler,
        config: coreServices.rootConfig,
      },
      async init({ httpRouter, logger, database, scheduler, config }) {
        httpRouter.use(
          await createRouterFromConfig({
            logger,
            database,
            scheduler,
            config,
            credentialsProvider:
              credentialsProvider ??
              new DefaultCopilotCredentialsProvider({ config }),
          }),
        );
        httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated',
        });
      },
    });
  },
});
