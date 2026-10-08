import Parser from '@postlight/parser';
import type { ContentPart, Loader } from './DocumentLoader';

/**
 * TextLoader handles loading and parsing of text-based documents and files.
 * Supports various text formats including HTML, plain text, markdown, CSV, JSON, YAML, XML, and source code files.
 * For HTML content, it uses the Postlight parser to extract readable content in markdown format.
 */
export class TextLoader implements Loader {
  /**
   * Loads and parses a document from a binary buffer.
   * For HTML content, attempts to parse and extract readable content using Postlight parser.
   * For other text formats, converts the buffer directly to UTF-8 text.
   * 
   * @param buffer - The binary data of the document to load
   * @param mimeType - The MIME type of the document
   * @returns Promise resolving to an array of content parts containing the parsed text
   */
  load = async (
    buffer: Uint8Array,
    mimeType: string,
  ): Promise<ContentPart[]> => {
    if (mimeType.startsWith('text/html')) {
      try {
        return await Parser.parse('https://example.invalid', {
          html: Buffer.from(buffer),
          contentType: 'markdown',
        }).then((result) => {
          return [
            {
              type: 'text',
              text: `# ${result.title || ''}\n\n${result.content || ''}`,
            },
          ];
        });
      } catch {
        // noop
      }
    }

    return [
      {
        type: 'text',
        text: Buffer.from(buffer).toString('utf8'),
      },
    ];
  };

  /**
   * Returns the MIME types supported by this loader.
   * Includes a regex pattern for all text/* types and specific MIME types for various file formats.
   * 
   * @returns Array of supported MIME types as strings and regular expressions
   */
  getSupportedMimeTypes = () => {
    const result = [] as string[];

    Object.values(this.getSupportedFileExtensions()).forEach((mimeType) => {
      if (mimeType.startsWith('text/')) {
        return;
      }

      result.push(mimeType);
    });

    return [/text\/.*/, ...new Set(result)];
  };

  /**
   * Returns a mapping of supported file extensions to their corresponding MIME types.
   * Covers text files, markup languages, data formats, configuration files, and source code files.
   * 
   * @returns Object mapping file extensions (without dots) to MIME type strings
   */
  getSupportedFileExtensions = () => {
    return {
      txt: 'text/plain',
      md: 'text/markdown',
      csv: 'text/csv',
      json: 'application/json',
      yaml: 'application/x-yaml',
      yml: 'application/x-yaml',
      xml: 'application/xml',
      html: 'text/html',
      htm: 'text/html',
      log: 'text/plain',
      tsv: 'text/tab-separated-values',
      ini: 'text/plain',
      conf: 'text/plain',
      bat: 'application/x-bat',
      sh: 'application/x-sh',
      py: 'text/x-python',
      java: 'text/x-java-source',
      c: 'text/x-c',
      cpp: 'text/x-c++src',
      css: 'text/css',
      js: 'application/javascript',
      ts: 'application/typescript',
      jsonl: 'application/json',
    };
  };
}

export default TextLoader;
