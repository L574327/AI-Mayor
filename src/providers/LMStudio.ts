import { IServiceProvider } from './types';

export default {
  name: 'LMStudio',
  apiBase: 'http://localhost:1234',
  currency: 'USD',
  options: {
    apiBaseCustomizable: true,
    modelsEndpoint: '/models',
  },
  chat: {
    apiSchema: ['base', 'model', 'proxy'],
    docs: {
      temperature:
        'Higher values will make the output more creative and unpredictable, while lower values will make it more precise.',
      presencePenalty:
        "Positive values penalize new tokens based on whether they appear in the text so far, increasing the model's likelihood to talk about new topics.",
      topP: 'An alternative to sampling with temperature, called nucleus sampling, where the model considers the results of the tokens with topP probability mass.',
    },
    placeholders: {
      base: 'localhost:1234',
    },
    presencePenalty: { min: -2, max: 2, default: 0 },
    topP: { min: 0, max: 1, default: 1 },
    temperature: { min: 0, max: 1, default: 0.9 },

    options: {
      modelCustomizable: true,
    },
    models: [],
  },
  embedding: {
    apiSchema: ['base'],
    placeholders: {
      base: 'localhost:1234',
    },
    options: {
      modelCustomizable: true,
    },
    models: [],
  },
} as IServiceProvider;
