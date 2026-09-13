// @qiun/ucharts ships without type declarations. Only the surface the trace view uses is described.
declare module '@qiun/ucharts' {
  export default class uCharts {
    constructor(opts: Record<string, unknown>);
    updateData(data: Record<string, unknown>): void;
    stopAnimation(): void;
  }
}
