import { config } from "../config";
import type { IAppConfig } from "../config";
import { XtreamProvider } from "./xtream/xtream.provider";
import type { IStreamProvider } from "./provider.types";

let provider: IStreamProvider | null = null;

export function initProvider(appConfig: IAppConfig = config): IStreamProvider {
  const type = appConfig.providerType;

  switch (type) {
    case "xtream":
      provider = new XtreamProvider(appConfig.xtream);
      break;
    // Future providers:
    // case 'm3u': provider = new M3UProvider(appConfig.m3u); break;
    // case 'plex': provider = new PlexProvider(appConfig.plex); break;
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }

  console.log(`[provider] Initialized: ${provider.name}`);
  return provider;
}

export function getProvider(): IStreamProvider {
  if (!provider)
    throw new Error(
      "Provider not initialized. Call initProvider() at startup.",
    );
  return provider;
}
