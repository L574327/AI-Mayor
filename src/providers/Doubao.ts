import { IServiceProvider } from './types';

const chatModels = [
  {
    id: 'doubao-1.5-thinking-pro',
    name: 'doubao-1.5-thinking-pro',
    description:
      'Doubao-1.5全新深度思考模型，在数学、编程、科学推理等专业领域及创意写作等通用任务中表现突出，在AIME 2024、Codeforces、GPQA等多项权威基准上达到或接近业界第一梯队水平。',
    contextWindow: 128000,
    maxTokens: 16384,
    defaultMaxTokens: 4096,
    inputPrice: 0.004,
    outputPrice: 0.016,
    extras: {
      modelId: 'doubao-1-5-thinking-pro-250415',
    },
    capabilities: {
      tools: {
        enabled: true,
      },
      vision: {
        enabled: false,
        allowBase64: true,
        allowUrl: true,
      },
    },
  },
  {
    id: 'doubao-1.5-vision-pro',
    name: 'doubao-1.5-vision-pro',
    description:
      'Doubao-1.5-vision-pro 全新升级的多模态大模型，视觉理解、分类、信息抽取、解题、视频理解等能力显著提升。',
    contextWindow: 128000,
    maxTokens: 16384,
    defaultMaxTokens: 4096,
    inputPrice: 0.003,
    outputPrice: 0.009,
    extras: {
      modelId: 'doubao-1.5-vision-pro-250328',
    },
    capabilities: {
      tools: {
        enabled: true,
      },
      vision: {
        enabled: true,
        allowBase64: true,
        allowUrl: true,
      },
    },
  },
  {
    id: 'doubao-vision-pro-32k',
    name: 'doubao-vision-pro-32k',
    contextWindow: 32000,
    maxTokens: 4096,
    defaultMaxTokens: 4000,
    inputPrice: 0.0008,
    outputPrice: 0.002,
    extras: {
      modelId: 'doubao-vision-pro-32k-241028',
    },
    capabilities: {
      vision: {
        enabled: true,
        allowBase64: true,
        allowUrl: true,
      },
    },
  },
  {
    id: 'doubao-vision-lite-32k',
    name: 'doubao-vision-lite-32k',
    contextWindow: 4096,
    maxTokens: 4096,
    defaultMaxTokens: 4000,
    inputPrice: 0.0015,
    outputPrice: 0.0045,
    extras: {
      modelId: 'doubao-vision-lite-32k-241015',
    },
    capabilities: {
      vision: {
        enabled: true,
        allowBase64: true,
        allowUrl: true,
      },
    },
  },
  {
    id: 'doubao-1.5-pro-256k',
    name: 'doubao-1.5-pro-256k',
    description:
      'Doubao-1.5-pro，全新一代主力模型，性能全面升级，在知识、代码、推理、等方面表现卓越。',
    contextWindow: 12288,
    maxTokens: 12288,
    defaultMaxTokens: 4096,
    inputPrice: 0.0025,
    outputPrice: 0.0045,
    extras: {
      modelId: 'doubao-1-5-pro-256k-250115',
    },
    capabilities: {
      tools: {
        enabled: true,
      },
    },
  },
  {
    id: 'doubao-1.5-pro-32k',
    name: 'doubao-1.5-pro-32k',
    description:
      '在多项公开测评基准上达到全球领先水平，特别在知识、代码、推理、中文权威测评基准上获得最佳成绩，综合得分优于GPT4o、Claude 3.5 Sonnet等业界一流模型。',
    contextWindow: 12288,
    maxTokens: 12288,
    defaultMaxTokens: 4096,
    inputPrice: 0.0004,
    outputPrice: 0.001,
    extras: {
      modelId: 'doubao-1-5-pro-32k-250115',
    },
    capabilities: {
      tools: {
        enabled: true,
      },
    },
  },
  {
    id: 'doubao-1.5-lite-32k',
    name: 'doubao-1.5-lite-32k',
    description:
      'Doubao-1.5-lite，全新一代轻量版模型，极致响应速度，效果与时延均达到全球一流水平。',
    contextWindow: 12288,
    maxTokens: 12288,
    defaultMaxTokens: 4096,
    inputPrice: 0.0001,
    outputPrice: 0.0003,
    extras: {
      modelId: 'doubao-1-5-lite-32k-250115',
    },
    capabilities: {
      tools: {
        enabled: true,
      },
    },
  },
  {
    id: 'doubao-pro-256k',
    name: 'doubao-pro-256k',
    description:
      'Doubao-pro是豆包推出行业领先的专业版大模型。模型在参考问答、摘要总结、创作等广泛的应用场景上能提供优质的回答，是同时具备高质量与低成本的极具性价比模型。',
    contextWindow: 256000,
    maxTokens: 4096,
    defaultMaxTokens: 4000,
    inputPrice: 0.005,
    outputPrice: 0.009,
    extras: {
      modelId: 'doubao-pro-256k-241115',
    },
    capabilities: {
      tools: {
        enabled: true,
      },
    },
  },
  {
    id: 'doubao-pro-128k',
    name: 'doubao-pro-128k',
    contextWindow: 128000,
    maxTokens: 4096,
    defaultMaxTokens: 4000,
    inputPrice: 0.005,
    outputPrice: 0.009,
    isDefault: true,
    capabilities: {
      tools: {
        enabled: true,
      },
    },
  },
  {
    id: 'doubao-pro-32k',
    name: 'doubao-pro-32k',
    contextWindow: 32000,
    maxTokens: 4096,
    defaultMaxTokens: 4000,
    inputPrice: 0.0008,
    outputPrice: 0.002,
    extras: {
      modelId: 'doubao-pro-32k-241215',
    },
    capabilities: {
      tools: {
        enabled: true,
      },
    },
  },
  {
    id: 'doubao-pro-4k',
    name: 'doubao-pro-4k',
    contextWindow: 4000,
    maxTokens: 4096,
    defaultMaxTokens: 4000,
    inputPrice: 0.0008,
    outputPrice: 0.002,
    capabilities: {
      tools: {
        enabled: true,
      },
    },
  },
  {
    id: 'doubao-lite-128k',
    name: 'doubao-lite-128k',
    contextWindow: 128000,
    defaultMaxTokens: 4000,
    maxTokens: 4096,
    inputPrice: 0.0008,
    outputPrice: 0.001,
    extras: {
      modelId: 'doubao-lite-128k-240828',
    },
    capabilities: {
      tools: {
        enabled: true,
      },
    },
  },
  {
    id: 'doubao-lite-32k',
    name: 'doubao-lite-32k',
    contextWindow: 32000,
    maxTokens: 4096,
    defaultMaxTokens: 4000,
    inputPrice: 0.0003,
    outputPrice: 0.0006,
    extras: {
      modelId: 'doubao-lite-32k-240828',
    },
    capabilities: {
      tools: {
        enabled: true,
      },
    },
  },
  {
    id: 'doubao-lite-4k',
    name: 'doubao-lite-4k',
    description:
      'Doubao-lite是豆包推出的轻量级大模型，具备极致的响应速度，适用于对时延有更高要求的场景，模型配合精调使用可以获得更优质的效果。',
    contextWindow: 4000,
    maxTokens: 4096,
    defaultMaxTokens: 4000,
    inputPrice: 0.0003,
    outputPrice: 0.0006,
    extras: {
      modelId: 'doubao-lite-4k-character-240828',
    },
  },
];

export default {
  name: 'Doubao',
  apiBase: 'https://api.doubao.com/v1',
  currency: 'CNY',
  options: {
    apiBaseCustomizable: true,
    apiKeyCustomizable: true,
  },
  chat: {
    docs: {
      modelId: '接入点名称, 类似 ep-20241101123241-24smv',
      temperature:
        'Higher values will make the output more creative and unpredictable, while lower values will make it more precise.',
      presencePenalty:
        "Positive values penalize new tokens based on whether they appear in the text so far, increasing the model's likelihood to talk about new topics.",
      topP: 'An alternative to sampling with temperature, called nucleus sampling, where the model considers the results of the tokens with topP probability mass.',
      model: '用于统计用量和控制上下文长度，请选择与部署一致的模型',
    },
    apiSchema: ['base', 'key', 'proxy'],
    modelExtras: ['modelId'],
    frequencyPenalty: { min: -2, max: 2, default: 0 },
    topP: { min: 0, max: 1, default: 0.7 },
    presencePenalty: { min: -2, max: 2, default: 0 },
    temperature: { min: 0, max: 1, default: 1 },
    options: {
      modelCustomizable: true,
    },
    models: chatModels,
  },
} as IServiceProvider;
