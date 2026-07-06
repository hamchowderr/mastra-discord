// Ambient shim: @mastra/core ships `./test-utils/llm-mock` as a runtime export
// but its package.json points `types` at a .d.ts that isn't published. Declare
// the slice we use so `tsc --noEmit` (which includes test/) stays green.
declare module '@mastra/core/test-utils/llm-mock' {
  export function createMockModel(opts: {
    mockText?: string | Record<string, unknown>;
    objectGenerationMode?: 'json';
    spyGenerate?: (props: unknown) => void;
    spyStream?: (props: unknown) => void;
    version?: 'v1' | 'v2';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): any;
}
