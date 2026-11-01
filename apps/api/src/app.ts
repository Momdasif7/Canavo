import express from "express";
import "./outbox-tasks";
import cors from "cors";
import { allowedOrigin } from "./lib/cors";
import { gauge, httpLogger, httpMetrics, metricsEndpoint, requestId } from "./lib/observability";
import { platformPrisma } from "./db";
import helmet from "helmet";
import morgan from "morgan";
import swaggerUi from "swagger-ui-express";
import { env, isProd } from "./env";
import { errorHandler, notFound } from "./lib/http";
import { openapi } from "./openapi";
import { publicRouter } from "./routes/public";
import { authRouter } from "./routes/auth";
import { outletsRouter } from "./routes/outlets";
import { staffRouter } from "./routes/staff";
import { attendanceRouter } from "./routes/attendance";
import { menuRouter } from "./routes/menu";
import { ordersRouter } from "./routes/orders";
import { kotRouter } from "./routes/kot";
import { reportsRouter } from "./routes/reports";
import { notificationsRouter } from "./routes/notifications";
import { inventoryRouter } from "./routes/inventory";
import { tablesRouter } from "./routes/tables";
import { reservationsRouter } from "./routes/reservations";
import { deliveryRouter } from "./routes/delivery";
import { customersRouter } from "./routes/customers";
import { offersRouter } from "./routes/offers";
import { adminRouter } from "./routes/admin";
import { uploadsRouter } from "./routes/uploads";
import { platformRouter } from "./routes/platform";
import { taxRatesRouter } from "./routes/tax-rates";
import { supportRouter } from "./routes/support";
import { cashShiftsRouter } from "./routes/cash-shifts";
import { giftCardsRouter } from "./routes/gift-cards";
import { settlementsRouter } from "./routes/settlements";
import { canteenRouter } from "./routes/canteen";

gauge("canavo_outbox_pending", "Outbox events waiting for delivery", () => platformPrisma.outboxEvent.count({ where: { deliveredAt: null, failedAt: null } }));
gauge("canavo_outbox_dead", "Outbox events that gave up (dead-lettered)", () => platformPrisma.outboxEvent.count({ where: { failedAt: { not: null } } }));

export function createApp() {
  const app = express();
  // Trust only local/private proxies (the CANAVO gateway, ngrok, Render's load balancer) so req.ip is the real client.
  app.set("trust proxy", env.TRUST_PROXY);
  app.use(requestId);
  app.use(httpMetrics);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors({ origin: allowedOrigin(), exposedHeaders: ["content-disposition"], credentials: true }));
  // Structured JSON access logs in production (or LOG_FORMAT=json); short lines in development.
  if (isProd || env.LOG_FORMAT === "json") app.use(httpLogger);
  else app.use(morgan("dev"));

  // Public routes first: the Razorpay webhook needs the raw body.
  app.use(publicRouter);
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true, service: "canavo-api" }));
  app.get("/metrics", metricsEndpoint);
  /** Readiness for the host's health check: the database must answer. */
  app.get("/ready", async (_req, res) => {
    try {
      await platformPrisma.$queryRaw`SELECT 1`;
      res.json({ ok: true, db: "up" });
    } catch {
      res.status(503).json({ ok: false, db: "down" });
    }
  });
  app.get("/openapi.json", (_req, res) => res.json(openapi));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapi));

  app.use("/auth", authRouter);
  app.use("/outlets", outletsRouter);
  app.use("/staff", staffRouter);
  app.use("/attendance", attendanceRouter);
  app.use("/menu", menuRouter);
  app.use("/orders", ordersRouter);
  app.use("/kot", kotRouter);
  app.use("/reports", reportsRouter);
  app.use("/notifications", notificationsRouter);
  app.use("/inventory", inventoryRouter);
  app.use("/tables", tablesRouter);
  app.use("/reservations", reservationsRouter);
  app.use("/delivery", deliveryRouter);
  app.use("/customers", customersRouter);
  app.use("/offers", offersRouter);
  app.use("/admin", adminRouter);
  app.use("/uploads", uploadsRouter);
  app.use("/platform", platformRouter);
  app.use("/tax-rates", taxRatesRouter);
  app.use("/support-access", supportRouter);
  app.use("/cash-shifts", cashShiftsRouter);
  app.use("/gift-cards", giftCardsRouter);
  app.use("/settlements", settlementsRouter);
  app.use("/canteen", canteenRouter);

  app.use(() => {
    throw notFound("Route");
  });
  app.use(errorHandler);
  return app;
}
