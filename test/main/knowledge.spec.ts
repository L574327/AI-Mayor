import { describe, expect } from '@jest/globals';
import Knowledge from '../../src/main/knowledge';
import { embed } from '../../src/main/embedder';
import { randomId } from '../../src/main/util';

beforeAll(async () => {
  const originalImplementation = Array.isArray;
  // @ts-ignore
  Array.isArray = jest.fn((type) => {
    if (
      type &&
      type.constructor &&
      (type.constructor.name === 'Float32Array' ||
        type.constructor.name === 'BigInt64Array')
    ) {
      return true;
    }
    return originalImplementation(type);
  });
});

describe('VectorDB', () => {
  it('getInstance', async () => {
    const db = await Knowledge.getDatabase();
    expect(db).toBeDefined();
  });

  it('Add', async () => {
    const texts = [
      `三月七日，沙湖道中遇雨。雨具先去，同行皆狼狈，余独不觉。已而遂晴，故作此词。
莫听穿林打叶声，何妨吟啸且徐行。竹杖芒鞋轻胜马，谁怕？一蓑烟雨任平生。
料峭春风吹酒醒，微冷，山头斜照却相迎。回首向来萧瑟处，归去，也无风雨也无晴`,
      `基于即将启动的“未来城市大奖2024”，36氪将与清华大学人工智能国际治理研究院等机构密切沟通合作，通过场景征集、案例互荐、成果联合发布等形式，共同助力《白皮书》的编著及推广。`,
      `今年1月2日，蜜雪冰城、古茗同日向港交所递交上市招股书，然而它们的上市进程一直没有实质性进展，如今招股书均已失效。值得注意的是，招股书失效并不意味着企业放弃上市，它们可以补充新的财务数据，再次递交。但截至发稿，均未在港交所发现两家企业重新递表。`,
      `7 月 2 日凌晨，知名人工智能专家、OpenAI 的联合创始人 Andrej Karpathy 在社交平台上发帖，提出了一个关于未来计算机的构想：“100％ Fully Software2.0”， 计算机未来将完全由神经网络驱动，不依赖传统软件代码。`,
    ];
    const vector: any = await embed(texts);
    const data = texts.map((text, index) => {
      return {
        id: randomId(),
        collection_id: '1',
        file_id: '1',
        content: text,
        vector: vector[index],
      };
    });
    await Knowledge.add(data);
  });

  it('Search', async () => {
    const texts1 = [`何妨吟啸且徐行`];
    const vector1: any = await embed(texts1);
    const result1 = await Knowledge.search(['1'], vector1[0], { limit: 1 });
    expect(result1[0].content).toContain('一蓑烟雨任平生');

    const texts2 = [`软件未来将由神经网络驱动`];
    const vector2: any = await embed(texts2);
    const result2 = await Knowledge.search(['1'], vector2[0], { limit: 1 });
    expect(result2[0].content).toContain('Andrej Karpathy');
  });
});

afterAll(async () => {
  await Knowledge.remove({ collectionId: 1 });
  await Knowledge.close();
});
