import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/index";
import { ThemeProvider } from "@/lib/theme";

beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); document.documentElement.className = ""; });
afterEach(() => vi.unstubAllGlobals());

const Home = Route.options.component!;
const renderApp = () => render(<ThemeProvider><Home /></ThemeProvider>);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("Briefly UI", () => {
  it("shows the engine/key section at startup", async () => {
    renderApp();
    expect(await screen.findByText(/On-device · no key/)).toBeInTheDocument();
    expect(screen.getByText(/AI provider · your key/)).toBeInTheDocument();
  });

  it("works with no key: samples → topic warning → on-device summary", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Try samples/ }));
    expect((await screen.findAllByText(/Sample · Renewable energy report/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Different topic from most sources/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /^Summarize$/ }));
    expect(await screen.findByLabelText("Summary", {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /PowerPoint/ })).toBeInTheDocument();
    // off-topic sample excluded by default → only 2 sources used
    expect(screen.getByText(/2 sources/)).toBeInTheDocument();
  }, 15000);

  it("shows the length slider at startup (1%–50%, default 5%)", async () => {
    renderApp();
    const slider = await screen.findByRole("slider", { name: /Percent of the original to keep/ });
    expect(slider).toHaveAttribute("aria-valuemin", "1");
    expect(slider).toHaveAttribute("aria-valuemax", "50");
    expect(slider).toHaveAttribute("aria-valuenow", "5");
  });

  it("chapters: detected from pasted headings, summarized chapter by chapter", async () => {
    const user = userEvent.setup();
    const body = (t: string) => Array.from({ length: 14 }, (_, i) => `The ${t} changes in a measurable way when the mixture is cooled during stage ${i}, which producers track carefully.`).join(" ");
    const text = `# Water\n\n${body("water")}\n\n# Sugars\n\n${body("sugar")}\n\n# Fats\n\n${body("fat")}`;
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Paste text/ }));
    await user.click(screen.getByLabelText("Paste text"));
    await user.paste(text);
    await user.click(screen.getByRole("button", { name: /Add text/ }));
    expect(await screen.findByRole("button", { name: /3\/3 chapters/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Summarize chapter by chapter")).toBeChecked();
    await user.click(screen.getByRole("button", { name: /^Summarize$/ }));
    const water = await screen.findByRole("region", { name: "Water" }, { timeout: 8000 });
    expect(water).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Fats" })).toBeInTheDocument();
    expect(screen.queryByText(/\[1\]/)).not.toBeInTheDocument();
  }, 15000);

  it("help bubbles open on tap/click", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: /How Briefly handles your data/ }));
    expect(await screen.findByText(/Nothing is uploaded to our servers/)).toBeInTheDocument();
  });

  it("theme changer sets dark mode and palette", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Change theme/ }));
    await user.click(await screen.findByRole("radio", { name: /Dark/ }));
    await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
    await user.click(screen.getByRole("radio", { name: /Ocean/ }));
    await waitFor(() => expect(document.documentElement.dataset["palette"]).toBe("ocean"));
    expect(JSON.parse(localStorage.getItem("briefly-theme-v1")!)).toMatchObject({ mode: "dark", palette: "ocean" });
  });

  it("AI key flow: lists only that provider's models; rejects bad key without saving", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("generativelanguage")) return json({ models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }] });
      return json({ error: { message: "Incorrect API key provided" } }, 401);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp();
    await user.click(await screen.findByText(/AI provider · your key/));
    await user.click(screen.getByRole("radio", { name: /OpenAI/ }));
    await user.type(screen.getByLabelText(/OpenAI API key/), "sk-bad-key-123");
    await user.click(screen.getByRole("button", { name: /Verify & save key/ }));
    expect(await screen.findByText(/rejected this key/)).toBeInTheDocument();
    expect(localStorage.getItem("briefly-keys-v2") ?? "{}").not.toContain("sk-bad");

    await user.click(screen.getByRole("radio", { name: /Gemini/ }));
    await user.type(screen.getByLabelText(/Gemini API key/), "AIzaSyA1234567890abcdefghijk");
    await user.click(screen.getByRole("button", { name: /Verify & save key/ }));
    await waitFor(() => expect(localStorage.getItem("briefly-keys-v2")).toContain("AIzaSyA1234567890abcdefghijk"));
    expect(JSON.parse(localStorage.getItem("briefly-prefs-v2")!).models.google).toBe("gemini-2.5-flash");
    expect(JSON.parse(localStorage.getItem("briefly-prefs-v2")!).models.openai).toBeUndefined();
  }, 15000);

  it("detects a key pasted into the wrong provider", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByText(/AI provider · your key/));
    await user.click(screen.getByRole("radio", { name: /Gemini/ }));
    await user.type(screen.getByLabelText(/Gemini API key/), "sk-proj-abcdefghijklmnop");
    expect(await screen.findByRole("button", { name: /Switch to OpenAI/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Verify & save key/ })).toBeDisabled();
    void within;
  });
});
