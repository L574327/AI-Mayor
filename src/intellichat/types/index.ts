export type MessageContentPartText = {
  type: 'text';
  text: string;
};

export type MessageContentPartRefusal = {
  type: 'refusal';
  refusal: string;
};

export type MessageContentPartImage = {
  type: 'image';
  source:
    | {
        type: 'base64';
        data: string;
        mimetype: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
      }
    | {
        type: 'url';
        url: string;
      }
    | {
        type: 'file';
        id: string;
      };
};

export type MessageContentPartAudio = {
  type: 'audio';
  source: {
    type: 'base64';
    data: string;
    mimetype: 'audio/mpeg' | 'audio/wav';
  };
};

export type MessageContentPartDocument = {
  type: 'document';
  source:
    | {
        type: 'base64';
        data: string;
        mimetype: 'application/pdf';
      }
    | {
        type: 'text';
        data: string;
        mimetype: 'text/plain';
      }
    | {
        type: 'content';
        content:
          | string
          | Array<MessageContentPartImage | MessageContentPartText>;
      }
    | {
        type: 'url';
        url: string;
      }
    | {
        type: 'file';
        id: string;
      };
};

// TODO: Anthropic only
// export type MessageContentPartSearchResult = {};
// export type MessageContentPartThinking = {};
// export type MessageContentPartRedactedThinking = {};
// export type MessageContentPartToolUse = {};
// export type MessageContentPartToolResult = {};
// export type MessageContentPartServerToolUse = {};
// export type MessageContentPartCodeExecutionToolResult = {};
// export type MessageContentPartMCPToolUse = {};
// export type MessageContentPartMCPToolResult = {};
// export type MessageContentPartContainerUpload = {};

export type MessageContentPart =
  | MessageContentPartText
  | MessageContentPartRefusal
  | MessageContentPartImage
  | MessageContentPartDocument
  | MessageContentPartAudio;
