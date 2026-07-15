import axios, { AxiosInstance } from "axios";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { config } from "../config";

export type PaginationParams = {
  page?: number;
  perPage?: number;
};

const API_BASE_URL = "https://api.mn.co/admin/v1";

let mightyClientPromise: Promise<MightyClient> | undefined;
let mightyApiKeyPromise: Promise<string> | undefined;

export class MightyClient {
  private client: AxiosInstance;
  private networkId: string;

  constructor(mightyApiKey: string, networkId: string) {
    this.networkId = networkId;

    this.client = axios.create({
      baseURL: API_BASE_URL,
      timeout: 10000,
      headers: {
        Authorization: `Bearer ${mightyApiKey}`,
        "Content-Type": "application/json",
      },
    });
  }

  async getSpaceFeed(spaceId: string, params: PaginationParams = {}) {
    const { page = 1, perPage = 25 } = params;
    const response = await this.client.get(
      `/networks/${this.networkId}/posts`,
      {
        params: {
          space_id: spaceId,
          page,
          per_page: perPage,
        },
      },
    );
    return response.data;
  }

  async getSpaceEvents(spaceId: string, params: PaginationParams = {}) {
    const { page = 1, perPage = 50 } = params;
    const response = await this.client.get(`/networks/${this.networkId}/posts`, {
      params: {
        space_id: spaceId,
        page,
        per_page: perPage,
      },
    });

    const filtered =
      Array.isArray(response.data?.items) && response.data.items.length
        ? response.data.items.filter((post: { post_type?: string }) => post.post_type === "event")
        : [];

    const detailed = await Promise.all(
      filtered.map(async (event: { id: string | number }) => {
        try {
          const detail = await this.client.get(
            `/networks/${this.networkId}/events/${event.id}`,
          );
          return detail.data;
        } catch (error) {
          return event;
        }
      }),
    );

    return {
      ...response.data,
      items: detailed,
    };
  }

  async listSpaces(params: PaginationParams = {}) {
    const { page = 1, perPage = 25 } = params;
    const response = await this.client.get(
      `/networks/${this.networkId}/spaces`,
      {
        params: {
          page,
          per_page: perPage,
        },
      },
    );
    return response.data;
  }
}

export const getMightyClient = () => {
  mightyClientPromise ??= createMightyClient();
  return mightyClientPromise;
};

const createMightyClient = async () => {
  if (!config.mightyNetworkId) {
    throw new Error("MIGHTY_NETWORK_ID is required");
  }

  const mightyApiKey = await getMightyApiKey();
  return new MightyClient(mightyApiKey, config.mightyNetworkId);
};

const getMightyApiKey = () => {
  mightyApiKeyPromise ??= loadMightyApiKey();
  return mightyApiKeyPromise;
};

const loadMightyApiKey = async () => {
  if (config.mightyApiKey) {
    return config.mightyApiKey;
  }

  if (!config.mightyApiSecretArn) {
    throw new Error(
      "Set MIGHTY_API_KEY for local development or MIGHTY_API_SECRET_ARN in AWS.",
    );
  }

  const secretsManager = new SecretsManagerClient({});
  const response = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: config.mightyApiSecretArn }),
  );
  const secretValue =
    response.SecretString ??
    (response.SecretBinary
      ? Buffer.from(response.SecretBinary).toString("utf8")
      : undefined);

  if (!secretValue) {
    throw new Error("Mighty API secret has no value.");
  }

  let secret: unknown;
  try {
    secret = JSON.parse(secretValue);
  } catch {
    throw new Error("Mighty API secret must be JSON with a MIGHTY_API_KEY field.");
  }

  if (
    !secret ||
    typeof secret !== "object" ||
    !("MIGHTY_API_KEY" in secret) ||
    typeof secret.MIGHTY_API_KEY !== "string" ||
    !secret.MIGHTY_API_KEY
  ) {
    throw new Error("Mighty API secret is missing MIGHTY_API_KEY.");
  }

  return secret.MIGHTY_API_KEY;
};
