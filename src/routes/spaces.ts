import { Router } from "express";
import { MightyClient } from "../lib/mightyClient";

const router = Router();
const mighty = new MightyClient();

router.get("/", async (req, res, next) => {
  try {
    const page = Number(req.query.page ?? 1);
    const perPage = Number(req.query.per_page ?? 25);
    const spaces = await mighty.listSpaces({ page, perPage });
    res.json(spaces);
  } catch (error) {
    next(error);
  }
});

router.get("/:spaceId/feed", async (req, res, next) => {
  try {
    const { spaceId } = req.params;
    const page = Number(req.query.page ?? 1);
    const perPage = Number(req.query.per_page ?? 25);
    const feed = await mighty.getSpaceFeed(spaceId, { page, perPage });
    res.json(feed);
  } catch (error) {
    next(error);
  }
});

router.get("/:spaceId/events", async (req, res, next) => {
  try {
    const { spaceId } = req.params;
    const page = Number(req.query.page ?? 1);
    const perPage = Number(req.query.per_page ?? 25);
    const events = await mighty.getSpaceEvents(spaceId, { page, perPage });
    res.json(events);
  } catch (error) {
    next(error);
  }
});

export default router;
