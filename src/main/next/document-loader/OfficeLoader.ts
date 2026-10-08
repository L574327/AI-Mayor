import officeParser from 'officeparser';

import type { ContentPart, Loader } from './DocumentLoader';

/**
 * Loader implementation for Microsoft Office and OpenDocument format files.
 * Extracts text content from documents using the officeparser library.
 */
export class OfficeLoader implements Loader {
  /**
   * Parses an Office document buffer and extracts its text content.
   * 
   * @param buffer - The binary data of the Office document as a Uint8Array
   * @returns A promise that resolves to an array containing a single ContentPart with the extracted text
   * @throws Error if the document parsing fails
   */
  load = async (buffer: Uint8Array): Promise<ContentPart[]> => {
    try {
      const result = await officeParser.parseOfficeAsync(Buffer.from(buffer));

      return [
        {
          type: 'text',
          text: result || '',
        },
      ];
    } catch (error) {
      throw new Error(
        `Failed to parse Office document: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  };

  /**
   * Returns the MIME types supported by this loader.
   * 
   * @returns An array of MIME type strings for supported Office document formats
   */
  getSupportedMimeTypes = () => {
    return Object.values(this.getSupportedFileExtensions());
  };

  /**
   * Returns a mapping of supported file extensions to their corresponding MIME types.
   * Includes both Microsoft Office formats (docx, pptx, xlsx) and OpenDocument formats (odt, odp, ods).
   * 
   * @returns An object mapping file extensions to MIME type strings
   */
  getSupportedFileExtensions = () => {
    return {
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      odt: 'application/vnd.oasis.opendocument.text',
      odp: 'application/vnd.oasis.opendocument.presentation',
      ods: 'application/vnd.oasis.opendocument.spreadsheet',
    };
  };
}

export default OfficeLoader;
