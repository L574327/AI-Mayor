import { describe } from '@jest/globals';
import { embed } from '../../src/main/embedder';

/**
 * Sets up test environment before all tests run.
 * Mocks Array.isArray to return true for Float32Array and BigInt64Array types
 * in addition to regular arrays.
 */
beforeAll(() => {

  const originalImplementation = Array.isArray;
  // @ts-ignore
  Array.isArray = jest.fn((type) => {
    if (type && type.constructor && (type.constructor.name === "Float32Array" || type.constructor.name === "BigInt64Array")) {
      return true;
    }
    return originalImplementation(type);
  });
});

/**
 * Test suite for the Embedder functionality.
 */
describe('Embedder', () => {
  /**
   * Tests the embed function with sample Chinese text.
   * Verifies that the function processes multiple text inputs and returns
   * the expected number of results.
   */
  it('embed', async () => {
    /**
     * Progress callback function that logs embedding progress.
     * @param {number} total - Total number of items to process
     * @param {number} done - Number of items completed
     */
    const progressCallback = (total:number,done:number) => {
      console.log(`Progress: ${done}/${total}`);
    };
    const texts = ['杨家有女初长成', '养在深闺人未识'];
    const result = await embed(texts, progressCallback);
    expect(result.length).toBe(2);
  });
});