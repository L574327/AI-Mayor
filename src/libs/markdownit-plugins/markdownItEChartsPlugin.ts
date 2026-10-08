//@ts-ignore
import * as echarts from 'echarts';
//@ts-ignore
import MarkdownIt from 'markdown-it';
//@ts-ignore
import Token from 'markdown-it/lib/token.mjs';

export default function markdownItEChartsPlugin(md: MarkdownIt) {
  window.echarts = echarts; // 将 echarts 暴露到全局作用域中，以便在其他地方使用

  //
  const defaultFence =
    md.renderer.rules.fence ||
    function (
      tokens: Token[],
      idx: number,
      options: MarkdownIt.Options,
      env: any,
      self: MarkdownIt.Renderer,
    ) {
      return self.renderToken(tokens, idx, options);
    };

  // 覆盖fence渲染规则
  interface EChartsToken extends Token {
    info: string;
    content: string;
  }

  md.renderer.rules.fence = (
    tokens: Token[],
    idx: number,
    options: MarkdownIt.Options,
    env: any,
    self: MarkdownIt.Renderer,
  ): string => {
    const token = tokens[idx] as EChartsToken;
    const info = token.info.trim();

    //  only process code blocks with info 'echarts'
    if (info !== 'echarts') {
      return defaultFence(tokens, idx, options, env, self);
    }

    // generate a unique id for the chart container
    const chartId: string = 'echart-' + idx;
    const code: string = token.content.trim();

    return `
        <div class="echarts-container"
           id="${chartId}"
           data-echarts-config="${encodeURIComponent(code)}"
           style="width:100%;height:400px;">
           <pre class="overflow-y-auto" style="height:400px;max-width:100%;"><code>${code}</code></pre>
        </div>
      `;
  };
}
