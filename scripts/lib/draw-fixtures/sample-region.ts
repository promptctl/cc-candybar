import { ZonedCalendar } from "../../../src/utils/calendar.js";
import { regionFor } from "../../../src/utils/region.js";

// Fixed presentation facts for standalone sample bars and renderer fixtures.
export const SAMPLE_REGION = regionFor("en-US", "UTC");
export const SAMPLE_CALENDAR = new ZonedCalendar(SAMPLE_REGION.timeZone);
