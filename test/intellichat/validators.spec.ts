import { describe, expect, test } from '@jest/globals';
import {
  isValidMaxTokens,
  isValidTemperature,
} from '../../src/intellichat/validators';

describe('intellichat/validators', () => {
  test('isValidMaxToken', () => {
    const maxToken1 = 4096;
    expect(isValidMaxTokens(maxToken1, 'OpenAI', 'gpt-4-1106-preview')).toBe(
      true,
    );
    expect(isValidMaxTokens(maxToken1, 'OpenAI', 'gpt-4-vision-preview')).toBe(
      true,
    );
    expect(isValidMaxTokens(maxToken1, 'OpenAI', 'gpt-4-0613')).toBe(true);
    expect(isValidMaxTokens(maxToken1, 'Baidu', 'ERNIE-Bot 4.0')).toBe(true);

    const maxToken2 = 32768;
    expect(isValidMaxTokens(maxToken1, 'OpenAI', 'gpt-4-1106-preview')).toBe(
      true,
    );
    expect(isValidMaxTokens(maxToken2, 'OpenAI', 'gpt-4-32k-0613')).toBe(false);
    expect(isValidMaxTokens(maxToken2, 'OpenAI', 'gpt-4-0613')).toBe(false);
    expect(isValidMaxTokens(maxToken2, 'Baidu', 'ERNIE-Bot')).toBe(false);

    expect(isValidMaxTokens(maxToken2, 'OpenAI', 'ERNIE-Bot 4.0')).toBe(false);
  });

  test('isValidTemperature', () => {
    expect(isValidTemperature(1, 'OpenAI')).toBe(true);
    expect(isValidTemperature(1, 'Baidu')).toBe(true);
    expect(isValidTemperature(0, 'OpenAI')).toBe(true);
    expect(isValidTemperature(0, 'Baidu')).toBe(false);

    expect(isValidTemperature(2, 'OpenAI')).toBe(true);
    expect(isValidTemperature(2, 'Baidu')).toBe(false);

    expect(isValidTemperature(-1, 'OpenAI')).toBe(false);
    expect(isValidTemperature(-1, 'Baidu')).toBe(false);
  });
});
