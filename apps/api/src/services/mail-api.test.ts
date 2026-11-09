import { describe, expect, it } from "vitest";
import { mailApiRequest, parseFrom } from "./mail-api";

const mail = { to: "a@x.co", subject: "Hi", html: "<p>Hi</p>", attachments: [{ filename: "r.pdf", content: Buffer.from("PDF") }] };

describe("platform email over HTTPS", () => {
  it("parses the sender", () => {
    expect(parseFrom("CANAVO <ops@x.co>")).toEqual({ name: "CANAVO", email: "ops@x.co" });
    expect(parseFrom('"CANAVO Reports" <r@x.co>')).toEqual({ name: "CANAVO Reports", email: "r@x.co" });
    expect(parseFrom("ops@x.co")).toEqual({ email: "ops@x.co" });
  });

  it("Brevo: api-key header, sender object, base64 attachments", () => {
    const r = mailApiRequest("brevo", "k1", "CANAVO <ops@x.co>", mail);
    expect(r.url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(r.headers["api-key"]).toBe("k1");
    expect(r.body).toMatchObject({ sender: { name: "CANAVO", email: "ops@x.co" }, to: [{ email: "a@x.co" }], subject: "Hi", htmlContent: "<p>Hi</p>", attachment: [{ name: "r.pdf", content: "UERG" }] });
  });

  it("Resend: bearer token, from string, attachments", () => {
    const r = mailApiRequest("resend", "k2", "CANAVO <ops@x.co>", { ...mail, to: ["a@x.co", "b@x.co"] });
    expect(r.url).toBe("https://api.resend.com/emails");
    expect(r.headers.authorization).toBe("Bearer k2");
    expect(r.body).toMatchObject({ from: "CANAVO <ops@x.co>", to: ["a@x.co", "b@x.co"], html: "<p>Hi</p>", attachments: [{ filename: "r.pdf", content: "UERG" }] });
  });
});

describe("Gmail API", () => {
  it("builds a base64url RFC 822 message with the sender, subject, HTML and attachment", async () => {
    const { gmailRaw } = await import("./mail-api");
    const raw = Buffer.from(await gmailRaw("CANAVO <ops@x.co>", mail), "base64url").toString();
    expect(raw).toMatch(/^From: CANAVO <ops@x\.co>/m);
    expect(raw).toMatch(/^To: a@x\.co/m);
    expect(raw).toMatch(/^Subject: Hi/m);
    expect(raw).toMatch(/filename=r\.pdf/);
    expect(raw).toContain("UERG");
  });
});
