import { Router } from "express";
import { getCountyWeather } from "../lib/weatherClient";

const router = Router();

function coordinate(value: unknown, minimum: number, maximum: number) {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

router.get("/", async (req, res, next) => {
  const latitude = coordinate(req.query.lat, -90, 90);
  const longitude = coordinate(req.query.lon, -180, 180);

  if (latitude === undefined || longitude === undefined) {
    res.status(400).json({ error: "Valid lat and lon query parameters are required." });
    return;
  }

  try {
    const weather = await getCountyWeather(latitude, longitude);
    res.setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=300");
    res.json(weather);
  } catch (error) {
    next(error);
  }
});

export default router;
