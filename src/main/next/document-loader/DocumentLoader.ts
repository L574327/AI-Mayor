import { filetypemime } from 'magic-bytes.js';

import { FileURILoader } from './FileURILoader';
import { HttpURILoader } from './HttpURILoader';
import { OfficeLoader } from './OfficeLoader';
import { PDFLoader } from './PDFLoader';
import { TextLoader } from './TextLoader';

/**
 * Maximum allowed size for a URI resource in bytes.
 * Currently set to 10 MB (10 * 1024 * 1024 bytes).
 * If the resource size exceeds this limit, loading will be aborted
 * to prevent excessive memory usage.
 */
const MAX_URI_RESOURCE_SIZE = 10 * 1024 * 1024;

/**
 * DocumentLoader is the central orchestrator for loading documents from various sources
 * (buffers, file paths, URIs) and parsing them into normalized content parts.
 *
 * It delegates the actual parsing to registered `Loader` instances and the resource
 * fetching to registered `URILoader` instances.
 *
 * Supported features:
 * - MIME type detection based on file signature or extension
 * - Resource size limit enforcement
 * - Pluggable loader system for different document formats
 * - Pluggable URI loader system for different protocols
 */
export class DocumentLoader {
  #loaders: Loader[];

  #uriLoaders: URILoader[];

  private constructor() {
    this.#loaders = [];
    this.#uriLoaders = [];
  }

  registerLoader = (loader: Loader) => {
    this.#loaders.push(loader);
  };

  registerURILoader = (loader: URILoader) => {
    this.#uriLoaders.push(loader);
  };

  /**
   * Returns a list of MIME types supported by all registered loaders.
   */
  get supportedMimeTypes() {
    const mimeTypes = new Set<string | RegExp>();

    this.#loaders.forEach((loader) => {
      const supportedMimeTypes = loader.getSupportedMimeTypes();
      supportedMimeTypes.forEach((mimeType) => {
        mimeTypes.add(mimeType);
      });
    });

    return [...mimeTypes];
  }

  /**
   * Returns a mapping of all supported file extensions to their MIME types.
   * Keys are lowercase extensions without the leading dot.
   */
  get supportedFileExtensions() {
    const fileExtensions = {} as Record<string, string>;

    this.#loaders.forEach((loader) => {
      Object.entries(loader.getSupportedFileExtensions()).forEach(
        ([key, value]) => {
          fileExtensions[key.toLowerCase()] = value;
        },
      );
    });

    return fileExtensions;
  }

  /**
   * Returns a list of URI protocols supported by all registered URI loaders.
   */
  get supportedURIProtocols() {
    const protocols = new Set<string>();

    this.#uriLoaders.forEach((loader) => {
      const supportedProtocols = loader.getSupportedProtocols();
      supportedProtocols.forEach((protocol) => {
        protocols.add(protocol);
      });
    });

    return [...protocols];
  }

  #resolveLoader = (mimeType: string) => {
    // eslint-disable-next-line no-restricted-syntax
    for (const loader of this.#loaders) {
      // eslint-disable-next-line no-restricted-syntax
      for (const supportedMimeType of loader.getSupportedMimeTypes()) {
        if (
          typeof supportedMimeType === 'string' &&
          supportedMimeType === mimeType
        ) {
          return loader;
        }

        if (
          supportedMimeType instanceof RegExp &&
          supportedMimeType.test(mimeType)
        ) {
          return loader;
        }
      }
    }

    return undefined;
  };

  #isMimeTypeSupported = (mimeType?: string) => {
    if (!mimeType) {
      return false;
    }

    return !!this.#resolveLoader(mimeType);
  };

  #detectMimeType = (buffer?: Uint8Array, fileName?: string) => {
    if (!buffer && !fileName) {
      return undefined;
    }

    if (buffer) {
      return filetypemime(buffer)[0] as string | undefined;
    }

    const extension = fileName?.split('.').pop();

    if (extension) {
      return this.supportedFileExtensions[extension.toLowerCase()] || undefined;
    }

    return undefined;
  };

  /**
   * Loads a document from a binary buffer.
   *
   * If the MIME type is not provided, it will attempt to detect it.
   * If the type cannot be determined but the buffer is valid UTF-8 text,
   * the content will be returned as plain text.
   *
   * @param buffer - The binary document data.
   * @param mimeType - Optional MIME type override.
   * @returns A promise resolving to an array of content parts.
   */
  loadFromBuffer = async (buffer: Uint8Array, mimeType?: string) => {
    let finalMimeType = mimeType;

    if (!finalMimeType) {
      finalMimeType = this.#detectMimeType(buffer);
    }

    if (!finalMimeType) {
      // If the MIME type cannot be determined, attempt to decode the buffer as UTF-8.
      // If successful, treat the data as plain text.
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);

        return [
          {
            type: 'text',
            text,
          },
        ];
      } catch (e) {
        // Ignore error
      }
    }

    if (!finalMimeType) {
      throw new Error('Failed to detect MIME type');
    }

    if (!this.#isMimeTypeSupported(finalMimeType)) {
      throw new Error(`Unsupported MIME type: ${finalMimeType}`);
    }

    const loader = this.#resolveLoader(finalMimeType);

    if (!loader) {
      throw new Error(`Unsupported MIME type: ${finalMimeType}`);
    }

    return loader.load(buffer, finalMimeType);
  };

  /**
   * Loads a document from a given URI.
   *
   * Uses the appropriate URI loader based on the protocol.
   * Enforces a maximum resource size limit (`MAX_URI_RESOURCE_SIZE`).
   *
   * @param url - The URI string to load.
   * @param mimeType - Optional MIME type override.
   * @returns A promise resolving to an array of content parts.
   * @throws If the URI is invalid, the protocol is unsupported, or the resource exceeds the size limit.
   */
  loadFromURI = async (url: string, mimeType?: string) => {
    let parsedURL: URL;

    try {
      parsedURL = new URL(url);
    } catch (error) {
      throw new Error(`Invalid URI: ${url}`);
    }

    const protocol = parsedURL.protocol.toLowerCase().slice(0, -1);

    const loader = this.#uriLoaders.find((item) =>
      item.getSupportedProtocols().includes(protocol),
    );

    if (!loader) {
      throw new Error(`Unsupported protocol: ${protocol}`);
    }

    const resource = await loader.load(parsedURL);

    if (resource.size && resource.size > MAX_URI_RESOURCE_SIZE) {
      throw new Error(
        `Resource size (${resource.size} bytes) exceeds the maximum allowed size (${MAX_URI_RESOURCE_SIZE} bytes).`,
      );
    }

    if (!mimeType && resource.mimeType) {
      if (!this.#isMimeTypeSupported(resource.mimeType)) {
        throw new Error(`Unsupported MIME type: ${resource.mimeType}`);
      }
    }

    const reader = resource.stream.getReader();
    const chunks = [] as Uint8Array[];

    let totalBytesRead = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const chunk = await reader.read();

      if (chunk.value) {
        chunks.push(chunk.value);
        totalBytesRead += chunk.value.length;

        if (totalBytesRead > MAX_URI_RESOURCE_SIZE) {
          throw new Error(
            `Resource size (${totalBytesRead} bytes) exceeds the maximum allowed size (${MAX_URI_RESOURCE_SIZE} bytes).`,
          );
        }
      }

      if (chunk.done) {
        break;
      }
    }

    const finalBuffer = Uint8Array.from(Buffer.concat(chunks));
    const finalMimeType =
      mimeType ||
      resource.mimeType ||
      this.#detectMimeType(finalBuffer, resource.fileName);

    return this.loadFromBuffer(finalBuffer, finalMimeType);
  };

  /**
   * Loads a document from a local file path.
   *
   * Internally converts the path to a `file://` URI.
   *
   * @param filepath - The absolute file path.
   * @param mimeType - Optional MIME type override.
   * @returns A promise resolving to an array of content parts.
   */
  loadFromFilePath = async (filepath: string, mimeType?: string) => {
    return this.loadFromURI(
      `file://${filepath}`,
      mimeType || this.#detectMimeType(undefined, filepath),
    );
  };

  static #instance = new DocumentLoader();

  static get supportedMimeTypes() {
    return this.#instance.supportedMimeTypes;
  }

  static get supportedURIProtocols() {
    return this.#instance.supportedURIProtocols;
  }

  static get supportedFileExtensions() {
    return this.#instance.supportedFileExtensions;
  }

  static get loadFromBuffer() {
    return this.#instance.loadFromBuffer;
  }

  static get loadFromURI() {
    return this.#instance.loadFromURI;
  }

  static get loadFromFilePath() {
    return this.#instance.loadFromFilePath;
  }

  static get registerLoader() {
    return this.#instance.registerLoader;
  }

  static get registerURILoader() {
    return this.#instance.registerURILoader;
  }
}

DocumentLoader.registerURILoader(
  new FileURILoader(() => DocumentLoader.supportedFileExtensions),
);
DocumentLoader.registerURILoader(new HttpURILoader());

DocumentLoader.registerLoader(new TextLoader());
DocumentLoader.registerLoader(new PDFLoader());
DocumentLoader.registerLoader(new OfficeLoader());

/**
 * Represents a single piece of document content.
 *
 * Currently only supports plain text (`text`), but can be extended
 * to other content types in the future (e.g., images, tables).
 */
export type ContentPart = {
  type: 'text';
  text: string;
};

/**
 * Represents a resource loaded from a URI.
 *
 * Encapsulates the binary data stream and optional metadata
 * such as MIME type, file name, and file size.
 */
export type URIResource = {
  /**
   * A readable binary data stream (sequence of Uint8Array chunks).
   */
  stream: ReadableStream<Uint8Array>;
  mimeType?: string;
  fileName?: string;
  size?: number;
};

/**
 * Interface for document content loaders.
 *
 * Each loader is responsible for parsing a specific document format
 * and converting it into a normalized `ContentPart[]` representation.
 */
export interface Loader {
  load: (buffer: Uint8Array, mimeType: string) => Promise<ContentPart[]>;
  /**
   * Returns the MIME types supported by this loader.
   *
   * The array may contain strings or regular expressions.
   */
  getSupportedMimeTypes: () => Array<string | RegExp>;
  /**
   * Returns a mapping of supported file extensions to their MIME types.
   *
   * Keys should be file extensions (without the leading dot),
   * and values should be the corresponding MIME types.
   */
  getSupportedFileExtensions: () => Record<string, string>;
}

/**
 * Interface for URI resource loaders.
 *
 * Each URI loader handles retrieving raw resource data
 * from a specific protocol (e.g., `file://`, `http://`, `https://`).
 */
export interface URILoader {
  load: (url: URL) => Promise<URIResource>;
  /**
   * Returns a list of supported URI protocols (without `://`).
   *
   * Example: `['file', 'http', 'https']`
   */
  getSupportedProtocols: () => string[];
}

export default DocumentLoader;
