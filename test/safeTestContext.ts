import dotenv from "dotenv";
dotenv.config();

export const safeAddress = process.env.TESTING_SAFE_WALLET_ADDRESS!;
