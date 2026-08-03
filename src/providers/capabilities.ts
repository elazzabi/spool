import type { ProviderCapabilities } from './types.js';

export function defineCapabilities(
  capabilities: ProviderCapabilities,
): Readonly<ProviderCapabilities> {
  if (capabilities.needsInput && !capabilities.observe) {
    throw new Error('Needs input capability requires an observe capability');
  }
  if (capabilities.resume && !capabilities.inspect) {
    throw new Error('Resume capability requires an inspectable provider session');
  }
  if (capabilities.cancel && !capabilities.observe) {
    throw new Error('Cancel capability requires provider observation');
  }
  return Object.freeze({ ...capabilities });
}
