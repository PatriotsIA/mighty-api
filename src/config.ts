import dotenv from "dotenv";

dotenv.config();

const numberFromEnv = (value: string | undefined, defaultValue: number) => {
  const parsed = value ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : defaultValue;
};

export const config = {
  port: numberFromEnv(process.env.PORT, 4001),
  mightyApiKey: process.env.MIGHTY_API_KEY,
  mightyNetworkId: process.env.MIGHTY_NETWORK_ID,
  corsOrigin: process.env.CORS_ORIGIN || "*",
};
