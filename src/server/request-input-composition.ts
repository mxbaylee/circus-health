import type { ImportDiagnosticFields } from './import-diagnostics.ts';

const roles = ['system', 'developer', 'user', 'assistant', 'tool', 'other'] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Content-free measurements of the outgoing chat body, never token or decoded media estimates. */
export function requestInputComposition(body: unknown): ImportDiagnosticFields {
  const fields: Record<string, number | boolean | null> = {
    inputMessageCount: 0,
    inputArgumentCharacters: 0,
    inputArgumentBytes: 0,
    inputToolDefinitionCharacters: 0,
    inputToolDefinitionBytes: 0,
    inputMediaTransportBytes: 0,
    inputUnsupportedShapes: 0,
    inputCompositionComplete: true,
  };
  for (const role of roles) {
    fields[`input${role[0]!.toUpperCase()}${role.slice(1)}Messages`] = 0;
    fields[`input${role[0]!.toUpperCase()}${role.slice(1)}Characters`] = 0;
    fields[`input${role[0]!.toUpperCase()}${role.slice(1)}Bytes`] = 0;
  }
  const add = (key: string, count: number) => {
    fields[key] = Number(fields[key]) + count;
  };
  const unsupported = () => {
    add('inputUnsupportedShapes', 1);
    fields.inputCompositionComplete = false;
  };
  try {
    if (!object(body)) {
      unsupported();
      return fields;
    }
    if (!Array.isArray(body.messages)) unsupported();
    else
      for (const message of body.messages) {
        add('inputMessageCount', 1);
        if (!object(message)) {
          add('inputOtherMessages', 1);
          unsupported();
          continue;
        }
        const role = roles.find((role) => role !== 'other' && message.role === role) || 'other';
        const prefix = `input${role[0]!.toUpperCase()}${role.slice(1)}`;
        add(prefix + 'Messages', 1);
        if (role === 'other') unsupported();
        const text = (value: string) => {
          add(prefix + 'Characters', value.length);
          add(prefix + 'Bytes', Buffer.byteLength(value));
        };
        const content = message.content;
        if (typeof content === 'string') text(content);
        else if (Array.isArray(content))
          for (const part of content) {
            if (!object(part)) unsupported();
            else if (part.type === 'text' && typeof part.text === 'string') text(part.text);
            else if (
              part.type === 'image_url' &&
              object(part.image_url) &&
              typeof part.image_url.url === 'string'
            )
              add('inputMediaTransportBytes', Buffer.byteLength(part.image_url.url));
            else if (
              part.type === 'file' &&
              object(part.file) &&
              typeof part.file.file_data === 'string'
            )
              add('inputMediaTransportBytes', Buffer.byteLength(part.file.file_data));
            else unsupported();
          }
        else if (!(role === 'assistant' && (content === null || content === undefined)))
          unsupported();
        if (message.tool_calls !== undefined) {
          if (role !== 'assistant' || !Array.isArray(message.tool_calls)) unsupported();
          else
            for (const call of message.tool_calls) {
              if (
                object(call) &&
                call.type === 'function' &&
                object(call.function) &&
                typeof call.function.arguments === 'string'
              ) {
                add('inputArgumentCharacters', call.function.arguments.length);
                add('inputArgumentBytes', Buffer.byteLength(call.function.arguments));
              } else unsupported();
            }
        }
      }
    if (body.tools !== undefined) {
      if (!Array.isArray(body.tools)) unsupported();
      else {
        const serialized = JSON.stringify(body.tools);
        fields.inputToolDefinitionCharacters = serialized.length;
        fields.inputToolDefinitionBytes = Buffer.byteLength(serialized);
        for (const tool of body.tools)
          if (!object(tool) || tool.type !== 'function' || !object(tool.function)) unsupported();
      }
    }
    return fields;
  } catch {
    // Diagnostic failures must not change the transport's outcome. Partial counts are unknown.
    return Object.fromEntries(
      Object.keys(fields).map((key) => [key, key === 'inputCompositionComplete' ? false : null]),
    );
  }
}
