import { config } from '../config';
import { XtreamProvider } from './xtream/xtream.provider';
import type { IStreamProvider } from './provider.types';

let provider: IStreamProvider | null = null;

export function initProvider(): IStreamProvider {
  const type = config.providerType;

  switch (type) {
    case 'xtream':
      provider = new XtreamProvider(config.xtream);
      break;
    // Future providers:
    // case 'm3u': provider = new M3UProvider(config.m3u); break;
    // case 'plex': provider = new PlexProvider(config.plex); break;
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }

  console.log(`[provider] Initialized: ${provider.name}`);
  return provider;
}

export function getProvider(): IStreamProvider {
  if (!provider) throw new Error('Provider not initialized. Call initProvider() at startup.');
  return provider;
}
