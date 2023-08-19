export type SVGRendererMode = 'tables' | 'links' | 'all';

export interface SVGRendererOptions {
    renderMode?: SVGRendererMode;
    ignoreEnums?: boolean;
}
