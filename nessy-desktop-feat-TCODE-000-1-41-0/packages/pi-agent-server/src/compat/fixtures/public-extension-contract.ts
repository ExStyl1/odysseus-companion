import { Type } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';

export const publicExtensionContract: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.registerTool({
    name: 'nessy_contract_tool',
    label: 'Nessy contract tool',
    description: 'Compile-only public ExtensionFactory and ExtensionAPI contract.',
    parameters: Type.Object({ value: Type.String() }),
    async execute(_toolCallId, input) {
      return {
        content: [{ type: 'text', text: input.value }],
        details: {},
      };
    },
  });
};

export async function exercisePublicExtensionContract() {
  const tools: ToolDefinition[] = [];
  const api = {
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;

  await publicExtensionContract(api);
  if (tools.length !== 1 || !tools[0]) {
    throw new Error(`expected one captured public extension tool, got ${tools.length}`);
  }

  const tool = tools[0];
  const result = await tool.execute(
    'public-extension-contract-call',
    { value: 'captured' },
    undefined,
    undefined,
    {} as never,
  );
  return { tool, result };
}
