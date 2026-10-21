import type { ComponentEntry } from './types'
import { ApiKeyInput, type ApiKeySubmitData } from '@/components/apisetup/ApiKeyInput'

const logSubmit = (data: ApiKeySubmitData) => console.log('[Playground] Submit:', JSON.stringify(data, null, 2))

export const apiKeyInputComponents: ComponentEntry[] = [
  {
    id: 'api-key-custom-endpoint',
    name: 'Custom Endpoint',
    category: 'Agent Setup',
    description: 'ApiKeyInput with Custom preset — protocol toggle, base URL, and comma-separated models',
    component: ApiKeyInput,
    props: [
      {
        name: 'status',
        description: 'Validation status',
        control: {
          type: 'select',
          options: [
            { label: 'Idle', value: 'idle' },
            { label: 'Validating', value: 'validating' },
            { label: 'Success', value: 'success' },
            { label: 'Error', value: 'error' },
          ],
        },
        defaultValue: 'idle',
      },
      {
        name: 'errorMessage',
        description: 'Error message when status is error',
        control: { type: 'string', placeholder: 'Error message' },
        defaultValue: '',
      },
    ],
    variants: [
      {
        name: 'Empty (OpenAI compat)',
        description: 'Custom preset, OpenAI protocol selected, no values filled',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
            baseUrl: 'https://your-endpoint.com/v1',
            customApi: 'openai-completions',
          },
        },
      },
      {
        name: 'Model catalog — fetch + pick',
        description: 'OpenAI-compatible endpoint: "Fetch models" lists what the endpoint PUBLISHES, grouped by id family; picking writes the ids into the model field, and "Check access" shows a per-model entitlement verdict',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
            baseUrl: 'https://llm-proxy.t-tech.team',
            customApi: 'openai-completions',
            apiKey: 'sk-playground',
          },
        },
      },
      {
        name: 'Model catalog — already enrolled',
        description: 'Editing a connection that is already enrolled in the daily metadata refresh: the toggle reads ON, and an untouched save leaves enrollment alone',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
            baseUrl: 'https://llm-proxy.t-tech.team',
            customApi: 'openai-completions',
            apiKey: 'sk-playground',
            connectionDefaultModel: 'tgpt/qwen35-397b-a17b-fp8, anthropic/claude-opus-5',
            syncModelsFromEndpoint: true,
          },
        },
      },
      {
        name: 'Empty (Anthropic compat)',
        description: 'Custom preset, Anthropic protocol selected',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
            baseUrl: 'https://your-proxy.com',
            customApi: 'anthropic-messages',
          },
        },
      },
      {
        name: 'Alibaba DashScope (OpenAI)',
        description: 'Alibaba/Qwen endpoint — OpenAI compatible with 3 models',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            connectionDefaultModel: 'qwen3-coder-plus, qwen3-coder-flash, qwen-max',
            customApi: 'openai-completions',
          },
        },
      },
      {
        name: 'Ollama Local (OpenAI)',
        description: 'Local Ollama endpoint — OpenAI compatible',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
            baseUrl: 'http://localhost:11434/v1',
            connectionDefaultModel: 'qwen3-coder',
            customApi: 'openai-completions',
          },
        },
      },
      {
        name: 'Anthropic Proxy',
        description: 'Custom Anthropic-compatible proxy endpoint',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
            baseUrl: 'https://my-anthropic-proxy.internal/v1',
            connectionDefaultModel: 'claude-sonnet-4-6',
            customApi: 'anthropic-messages',
          },
        },
      },
      {
        name: 'Via Anthropic API Key flow',
        description: 'Custom endpoint accessed through Anthropic provider type',
        props: {
          providerType: 'anthropic',
          initialValues: {
            activePreset: 'custom',
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            connectionDefaultModel: 'qwen3-coder-plus, qwen3-coder-flash',
            customApi: 'openai-completions',
          },
        },
      },
      // P6.586 — the credential-header choice, whose done_means owed a playground
      // entry. The control renders only for a genuine custom endpoint (a branded
      // preset's scheme is already known and pinned in the payload builder), so
      // both variants are custom-preset with a base URL; without one the whole
      // block is hidden and there is nothing to review.
      //
      // Two variants rather than a knob, because the pair IS the review: the
      // default is the one almost every OpenAI-compatible endpoint wants, and
      // `x-api-key` is the one an Anthropic-shaped endpoint needs — and until
      // P6.586 the second was unreachable from the UI at all, while the model
      // layer had carried the field since P6.258 and both wires had honoured it
      // since P6.585.
      {
        name: 'Credential header — Authorization: Bearer (the default)',
        description: 'A custom endpoint that reads its key the ordinary way. This is what an untouched form saves.',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
            baseUrl: 'https://your-endpoint.com/v1',
            customApi: 'openai-completions',
            credentialHeader: 'authorization',
          },
        },
      },
      {
        name: 'Credential header — x-api-key',
        description: 'An endpoint that expects the key in its own header, the way the Anthropic Messages API does. Honoured on claude and codex; Pi has no host seam for it (P6.691).',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
            baseUrl: 'https://my-anthropic-proxy.internal/v1',
            customApi: 'anthropic-messages',
            credentialHeader: 'x-api-key',
          },
        },
      },
      {
        name: 'No Base URL (toggle hidden)',
        description: 'Custom preset but no base URL — protocol toggle should not appear',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
          },
        },
      },
      {
        name: 'Validation Error',
        description: 'Custom endpoint with connection error',
        props: {
          status: 'error',
          errorMessage: 'Connection failed: ECONNREFUSED 127.0.0.1:11434',
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
            baseUrl: 'http://localhost:11434/v1',
            connectionDefaultModel: 'qwen3-coder',
            customApi: 'openai-completions',
          },
        },
      },
      // UB14.38 — two states the v0.15.1 look reaches that no variant above shows.
      {
        name: 'Anthropic (default endpoint)',
        description: 'A default-provider preset: only the key field (its eye toggle named Show/Hide) and the hairline preset pill; the base URL and model fields are hidden',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'anthropic',
          },
        },
      },
      {
        name: 'Amazon Bedrock edit (IAM)',
        description: 'Reached only by editing a CLI-created Bedrock connection (AiSettingsPage passes its piAuthProvider; DA1.53 keeps Bedrock out of the picker, so the pill has no label): the authentication segments and the secret key with its own named eye toggle',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'amazon-bedrock',
          },
        },
      },
    ],
    mockData: () => ({
      onSubmit: logSubmit,
      providerType: 'pi_api_key',
      initialValues: {
        activePreset: 'custom',
        baseUrl: 'https://your-endpoint.com/v1',
        customApi: 'openai-completions',
      },
    }),
  },
]
