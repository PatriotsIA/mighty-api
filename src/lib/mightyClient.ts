import axios, { AxiosInstance } from "axios";
import { config } from "../config";

export type PaginationParams = {
  page?: number;
  perPage?: number;
};

const API_BASE_URL = "https://api.mn.co/admin/v1";

export class MightyClient {
  private client: AxiosInstance;
  private networkId: string;

  constructor() {
    if (!config.mightyApiKey) {
      throw new Error("MIGHTY_API_KEY is required");
    }
    if (!config.mightyNetworkId) {
      throw new Error("MIGHTY_NETWORK_ID is required");
    }

    this.networkId = config.mightyNetworkId;

    this.client = axios.create({
      baseURL: API_BASE_URL,
      timeout: 10000,
      headers: {
        Authorization: `Bearer ${config.mightyApiKey}`,
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
