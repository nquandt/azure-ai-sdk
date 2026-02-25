import { createJsonErrorResponseHandler } from '@ai-sdk/provider-utils';
import { z } from 'zod';

const azureFoundryErrorSchema = z.object({
  error: z.object({
    code: z.string().nullish(),
    message: z.string(),
    status: z.number().nullish(),
  }),
});

export type AzureFoundryErrorData = z.infer<typeof azureFoundryErrorSchema>;

export const azureFoundryFailedResponseHandler =
  createJsonErrorResponseHandler({
    errorSchema: azureFoundryErrorSchema,
    errorToMessage: (data) => data.error.message,
    isRetryable: (response) =>
      response.status === 429 || response.status >= 500,
  });
