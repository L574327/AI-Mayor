declare module '@postlight/parser' {
  export type ParseResult = {
    title: string | null;
    content: string | null;
    author: string | null;
    date_published: string | null;
    lead_image_url: string | null;
    dek: string | null;
    next_page_url: string | null;
    url: string;
    domain: string;
    excerpt: string | null;
    word_count: number;
    direction: 'ltr' | 'rtl';
    total_pages: number;
    rendered_pages: number;
  };

  export type ParseOptions = {
    contentType?: 'html' | 'markdown' | 'text' | undefined;
    headers?: object | undefined;
    html?: string | Buffer | undefined;
  };

  const Parser: {
    parse(url: string, options?: ParseOptions): Promise<ParseResult>;
    fetchResource(url: string): Promise<string>;
  };

  export default Parser;
}
