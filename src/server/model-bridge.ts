import { createHash, randomUUID } from 'node:crypto';
import { modelConfig, publicModelConfig } from './model-config.ts';
import { ModelError } from './model-errors.ts';
import {
  ProxyModelBridge,
  proxyCapabilities,
  isUnsupportedPdfError,
  isUnsupportedImageError,
} from './proxy-model-bridge.ts';
import type { HealthTool, ProxyConfig, ProxyModelBridgeOptions } from './proxy-model-bridge.ts';

type UnknownRecord = Record<string, unknown>;
const object = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
interface ConnectionReceipt extends UnknownRecord {
  testedAt: string;
  model: string;
  reasoningEffort: string | null;
  backend: 'litellm';
  fictional: true;
  capabilities: { tools: true; images: boolean | null; pdf: boolean | null };
}
interface ConnectionOptions extends Omit<
  ProxyModelBridgeOptions,
  'config' | 'onEvent' | 'onTool' | 'onExit'
> {
  config?: ProxyConfig;
  profileId?: string;
  image?: boolean;
  /** A PDF original requires a verified native route or verified image fallback. */
  pdf?: boolean;
}
interface ConnectionTestBridge {
  start(
    instructions: string,
    tools: HealthTool[],
  ): Promise<{
    model: string;
    reasoningEffort?: string | null;
    capabilities?: { images?: boolean | null; pdf?: boolean | null };
  }>;
  turn(text: string): Promise<unknown>;
  close(): void;
}
interface TestConnectionOptions extends ConnectionOptions {
  bridgeFactory?: (
    options: ProxyModelBridgeOptions & { profileId?: string },
  ) => ConnectionTestBridge;
  timeoutMs?: number;
}

const receipts = new Map<string, ConnectionReceipt>();
const preflights = new Map<string, Promise<UnknownRecord>>();
class EvidenceCapabilityError extends ModelError {
  readonly capability: 'pdf' | 'images';
  constructor(capability: 'pdf' | 'images', message: string) {
    super(message);
    this.capability = capability;
  }
}
const probesPdf = (config: ProxyConfig) =>
  config.pdfMode !== 'disabled' && (config.pdfMode === 'auto' || config.pdf);
const capabilitiesSettled = (config: ProxyConfig, receipt: ConnectionReceipt | undefined) =>
  receipt?.capabilities.tools === true &&
  (!probesPdf(config) || receipt.capabilities.pdf !== null) &&
  (!config.images || receipt.capabilities.images !== null);

/** Independently fictional challenge, present only in the PDF bytes. */
function fictionalPdf(code: string): string {
  const stream = `BT /F1 36 Tf 24 60 Td (${code}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let document = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((value, index) => {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${value}\nendobj\n`;
  });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  document += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  document += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return 'data:application/pdf;base64,' + Buffer.from(document).toString('base64');
}
const key = (config: ProxyConfig, profileId = '') =>
  createHash('sha256')
    .update(JSON.stringify([config, profileId]))
    .digest('hex');
const requireProxy = (config: ProxyConfig): void => {
  if (config.backend !== 'litellm')
    throw new ModelError('Only LiteLLM Proxy is supported. Configure the Docker LiteLLM service.');
};
/** Opaque prerequisite revision: configuration or an explicit successful connection check. */
export function modelRecoveryKey(profileId: string, config: ProxyConfig = modelConfig()): string {
  const identity = key(config, profileId);
  return identity + ':' + (receipts.get(identity)?.testedAt || '');
}
export function configuredModelIdentity(profileId?: string, config: ProxyConfig = modelConfig()) {
  const receipt = receipts.get(key(config, profileId));
  return { backend: config.backend, model: receipt?.model || config.model, reasoningEffort: null };
}
export function createModelBridge(
  options: Omit<ProxyModelBridgeOptions, 'config'> & {
    config?: ProxyConfig;
    profileId?: string;
  } = {},
): ProxyModelBridge {
  const config = options.config || modelConfig();
  requireProxy(config);
  const { profileId: _profileId, ...bridgeOptions } = options;
  const verified = receipts.get(key(config, options.profileId));
  return new ProxyModelBridge({
    ...bridgeOptions,
    config: {
      ...config,
      pdf: verified?.capabilities.pdf === true,
      images: verified?.capabilities.images === true,
    },
    onEvent: (method, params) => {
      if (method === 'model/evidenceFallback' && params.reason === 'pdf_unsupported') {
        // A new fictional test may have replaced the receipt while this turn
        // was running. Downgrade the current exact route/profile authority.
        const current = receipts.get(key(config, options.profileId));
        if (current) current.capabilities.pdf = false;
      }
      options.onEvent?.(method, params);
    },
  });
}
export async function modelAvailability({
  config,
  profileId,
  ...options
}: ConnectionOptions = {}): Promise<UnknownRecord> {
  try {
    config ||= modelConfig();
    const identity = publicModelConfig(config),
      receipt = receipts.get(key(config, profileId));
    requireProxy(config);
    const ready = capabilitiesSettled(config, receipt);
    const capabilities = receipt?.capabilities || { tools: null, images: null, pdf: null };
    await proxyCapabilities(config, options);
    return {
      ...identity,
      available: ready,
      readiness: ready ? 'tested' : 'untested',
      capabilities,
      connectionTest: receipt || null,
      message: ready
        ? 'Connection tested with fictional content. Model extraction quality still requires review.'
        : 'The connection will be checked automatically when you start.',
    };
  } catch (error) {
    return {
      available: false,
      readiness: 'unavailable',
      ...(config ? publicModelConfig(config) : {}),
      message:
        error instanceof ModelError
          ? error.message
          : 'AI configuration or connection is unavailable.',
    };
  }
}
export async function ensureModelConnection({
  config = modelConfig(),
  profileId,
  image = false,
  pdf = false,
  ...options
}: TestConnectionOptions = {}): Promise<UnknownRecord> {
  requireProxy(config);
  const identity = key(config, profileId);
  const prior = receipts.get(identity);
  const ready = (receipt: ConnectionReceipt | undefined) =>
    capabilitiesSettled(config, receipt) &&
    (!image || receipt?.capabilities.images === true) &&
    (!pdf || receipt?.capabilities.pdf === true || receipt?.capabilities.images === true);
  if (ready(prior))
    return {
      ...publicModelConfig(config),
      available: true,
      readiness: 'tested',
      capabilities: prior!.capabilities,
      connectionTest: prior,
      message: 'Connection ready.',
    };
  // Share only a fictional probe. No profile content or archive operations are
  // included, and an image request cannot reuse a text-only test as proof.
  const probeKey = identity + (image ? ':image' : pdf ? ':pdf' : ':text');
  if (!preflights.has(probeKey)) {
    const verify = async () => {
      if (probesPdf(config) && receipts.get(identity)?.capabilities.pdf == null) {
        try {
          await testModelConnection({ ...options, config, profileId, pdf: true });
        } catch (error) {
          if (!(error instanceof EvidenceCapabilityError) || error.capability !== 'pdf')
            throw error;
        }
      }
      if (image || config.images || (pdf && receipts.get(identity)?.capabilities.pdf !== true)) {
        if (receipts.get(identity)?.capabilities.images !== true) {
          try {
            await testModelConnection({ ...options, config, profileId, image: true });
          } catch (error) {
            if (
              !(error instanceof EvidenceCapabilityError) ||
              image ||
              receipts.get(identity)?.capabilities.pdf !== true
            )
              throw error;
          }
        }
      }
      if (!receipts.has(identity)) await testModelConnection({ ...options, config, profileId });
      const verified = receipts.get(identity);
      if (!ready(verified))
        throw new ModelError(
          'The selected model did not verify the required PDF or image input. Check the connection before importing.',
        );
      return {
        ...publicModelConfig(config),
        available: true,
        readiness: 'tested',
        capabilities: verified!.capabilities,
        connectionTest: verified,
        message: 'Connection verified with fictional evidence.',
      };
    };
    const probe = verify().finally(() => {
      if (preflights.get(probeKey) === probe) preflights.delete(probeKey);
    });
    preflights.set(probeKey, probe);
  }
  const pending = preflights.get(probeKey);
  if (!pending) throw new ModelError('The fictional connection test could not start.');
  return pending;
}
export async function testModelConnection({
  config = modelConfig(),
  profileId,
  image = false,
  pdf = false,
  bridgeFactory = (options) => new ProxyModelBridge(options),
  timeoutMs = 60000,
  ...options
}: TestConnectionOptions = {}): Promise<UnknownRecord> {
  requireProxy(config);
  if (pdf && config.pdfMode === 'disabled')
    throw new ModelError('PDF input is disabled by the operator.');
  if (pdf && image) throw new ModelError('Verify PDF and image evidence separately.');
  const nonce = randomUUID(),
    responseToken = randomUUID();
  let bridge: ConnectionTestBridge | undefined,
    timer: NodeJS.Timeout | undefined,
    called = false,
    text = '',
    info: Awaited<ReturnType<ConnectionTestBridge['start']>> | undefined;
  const visualCode = String(1000 + Math.floor(Math.random() * 9000));
  const retain = (capability: 'pdf' | 'images' | null, supported = true) => {
    const prior = receipts.get(key(config, profileId));
    const receipt: ConnectionReceipt = {
      testedAt: new Date().toISOString(),
      model: info!.model,
      reasoningEffort: info!.reasoningEffort || null,
      backend: config.backend,
      fictional: true,
      capabilities: {
        tools: true,
        images: prior?.capabilities.images ?? null,
        pdf: prior?.capabilities.pdf ?? null,
      },
    };
    if (capability) receipt.capabilities[capability] = supported;
    receipts.set(key(config, profileId), receipt);
    return receipt;
  };
  try {
    const complete = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        bridge?.close();
        reject(new ModelError('The fictional connection test timed out.'));
      }, timeoutMs);
      bridge = bridgeFactory({
        ...options,
        config: { ...config, pdf },
        profileId,
        onTool: async (params) => {
          if (params.tool !== 'health_connection_test' || params.arguments.challenge !== nonce)
            throw new ModelError('The fictional tool call did not match its challenge.');
          called = true;
          if (pdf)
            return {
              pdfContent: fictionalPdf(visualCode),
              metadata: {
                fictional: true,
                instruction:
                  'Read the four digits in this fictional PDF and include them in your final answer.',
              },
            };
          if (!image) return { response: responseToken, fictional: true };
          const { createCanvas } = await import('@napi-rs/canvas');
          const canvas = createCanvas(320, 120),
            ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, 320, 120);
          ctx.fillStyle = '#000000';
          ctx.font = 'bold 64px sans-serif';
          ctx.fillText(visualCode, 20, 85);
          return {
            metadata: {
              instruction:
                'Read the four digits in this fictional image and include them in your final answer.',
            },
            imageContent: canvas.toDataURL('image/png'),
          };
        },
        onExit: reject,
        onEvent: (method, params) => {
          const item = object(params.item) ? params.item : {};
          const turn = object(params.turn) ? params.turn : {};
          if (
            method === 'item/completed' &&
            item.type === 'agentMessage' &&
            typeof item.text === 'string'
          )
            text += item.text;
          if (method === 'turn/completed')
            turn.status === 'completed'
              ? resolve()
              : reject(new ModelError('The fictional connection test did not complete.'));
        },
      });
    });
    // Attach the rejection handler before awaiting bridge initialization.
    complete.catch(() => {});
    const activeBridge =
      bridge ??
      (() => {
        throw new ModelError('The fictional connection test could not start.');
      })();
    info = await activeBridge.start(
      'You are Moxie. This is a fictional setup test, with no patient data. You must call the supplied health_connection_test tool with the exact challenge in the user message before responding. Do not use other tools.',
      [
        {
          type: 'function',
          name: 'health_connection_test',
          description: 'Read fictional setup evidence.',
          inputSchema: {
            type: 'object',
            properties: { challenge: { type: 'string' } },
            required: ['challenge'],
            additionalProperties: false,
          },
        },
      ] satisfies HealthTool[],
    );
    if (image && info.capabilities?.images === false)
      throw new EvidenceCapabilityError(
        'images',
        'This model does not support images. Text setup may still be tested.',
      );
    await activeBridge.turn(
      `Call health_connection_test with challenge ${nonce}. Then ${pdf || image ? `read the returned ${pdf ? 'PDF' : 'image'} and answer with its four digits` : 'include the exact response returned by the tool in your answer'}.`,
    );
    await complete;
    if (!called)
      throw new ModelError('The model did not demonstrate the required fictional tool round trip.');
    if (!text.includes(pdf || image ? visualCode : responseToken)) {
      if (pdf || image)
        throw new EvidenceCapabilityError(
          pdf ? 'pdf' : 'images',
          `The model did not demonstrate fictional ${pdf ? 'PDF' : 'image'} reading.`,
        );
      throw new ModelError('The model did not demonstrate the required fictional tool round trip.');
    }
    const receipt = retain(pdf ? 'pdf' : image ? 'images' : null);
    return {
      ...publicModelConfig(config),
      available: true,
      readiness: 'tested',
      capabilities: receipt.capabilities,
      connectionTest: receipt,
      message: 'Fictional connection test passed. Patient records were not used.',
    };
  } catch (error) {
    if (
      pdf &&
      called &&
      info &&
      (isUnsupportedPdfError(error) || error instanceof EvidenceCapabilityError)
    ) {
      retain('pdf', false);
      throw new EvidenceCapabilityError(
        'pdf',
        'This route did not verify fictional PDF input; verified image fallback is required.',
      );
    }
    if (
      image &&
      info &&
      (error instanceof EvidenceCapabilityError || (called && isUnsupportedImageError(error)))
    ) {
      if (receipts.get(key(config, profileId))?.capabilities.pdf === true) retain('images', false);
      else receipts.delete(key(config, profileId));
      if (error instanceof EvidenceCapabilityError) throw error;
      throw new EvidenceCapabilityError(
        'images',
        'The model did not demonstrate fictional image reading.',
      );
    }
    receipts.delete(key(config, profileId));
    throw error instanceof ModelError
      ? error
      : new ModelError(
          'The fictional connection test failed. Check authentication, selected model, and server configuration.',
        );
  } finally {
    if (timer) clearTimeout(timer);
    bridge?.close();
  }
}
