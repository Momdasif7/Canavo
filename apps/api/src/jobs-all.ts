import { registerJobs as registerServiceJobs } from "./jobs-service";
import { registerJobs as registerCrmJobs } from "./jobs-crm";
import { registerJobs as registerPlatformJobs } from "./jobs-platform";
import { registerJobs as registerInventoryJobs } from "./jobs-inventory";
import { registerJobs as registerAlertJobs } from "./jobs-notifications";
import { registerJobs as registerCanteenJobs } from "./jobs-canteen";

/** Declare every module's scheduled jobs (they start with startJobs()). */
export function registerAllJobs() {
  registerServiceJobs();
  registerCrmJobs();
  registerPlatformJobs();
  registerInventoryJobs();
  registerAlertJobs();
  registerCanteenJobs();
}
