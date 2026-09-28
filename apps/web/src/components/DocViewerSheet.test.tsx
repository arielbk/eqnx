// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { DocViewerSheet } from "./DocViewerSheet.tsx";
import {
  LocalTraceSource,
  TraceDataSourceProvider,
} from "../lib/trace-data-source.ts";

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderSheet(
  docPath: string,
  onOpenChange: (open: boolean) => void = () => {},
  options: {
    knownDocPaths?: readonly string[];
    onNavigateDocRoute?: (route: string) => void;
    promoted?: { repoPath: string; missing: boolean; otherCheckout?: string };
  } = {},
) {
  const triggerRef = createRef<HTMLElement>();
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <DocViewerSheet
        taskRef="my-task"
        docPath={docPath}
        knownDocPaths={options.knownDocPaths}
        triggerRef={triggerRef}
        onOpenChange={onOpenChange}
        onNavigateDocRoute={options.onNavigateDocRoute}
        promoted={options.promoted}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

test("shows a loading state while doc contents are pending", () => {
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

  renderSheet("/work/docs/plan.md");

  expect(screen.getByText("Loading…")).toBeInTheDocument();
});

test("renders sanitized HTML for a markdown doc", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("<h1>Plan</h1><p>Body text</p>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ),
  );

  renderSheet("/work/docs/plan.md");

  expect(await screen.findByRole("heading", { name: "Plan" })).toBeInTheDocument();
  expect(screen.getByText("Body text")).toBeInTheDocument();
});

test("renders raw text in a contained fallback for a non-markdown doc", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response('{"key":"value"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );

  renderSheet("/work/docs/data.json");

  expect(await screen.findByText("Showing raw contents")).toBeInTheDocument();
  expect(screen.getByText('{"key":"value"}')).toBeInTheDocument();
});

test("shows a contained message when the doc is missing (404)", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));

  renderSheet("/work/docs/missing.md");

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This document could not be found.",
  );
});

test("shows a contained message when the doc is unreadable (500)", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("Doc could not be read", { status: 500 })),
  );

  renderSheet("/work/docs/unreadable.md");

  expect(await screen.findByRole("alert")).toHaveTextContent("Doc could not be read");
});

test("displays the doc's basename as the Sheet title", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("<p>Hi</p>", { status: 200, headers: { "content-type": "text/html" } }),
    ),
  );

  renderSheet("/work/docs/plan.md");

  expect(await screen.findByRole("heading", { name: "plan.md" })).toBeInTheDocument();
});

test("Escape dismisses the Sheet via onOpenChange(false)", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("<p>Hi</p>", { status: 200, headers: { "content-type": "text/html" } }),
    ),
  );
  const onOpenChange = vi.fn();

  renderSheet("/work/docs/plan.md", onOpenChange);
  await screen.findByText("Hi");

  fireEvent.keyDown(document, { key: "Escape" });

  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("the Close button dismisses the Sheet via onOpenChange(false)", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("<p>Hi</p>", { status: 200, headers: { "content-type": "text/html" } }),
    ),
  );
  const onOpenChange = vi.fn();

  renderSheet("/work/docs/plan.md", onOpenChange);
  await screen.findByText("Hi");

  fireEvent.click(screen.getByRole("button", { name: "Close" }));

  expect(onOpenChange).toHaveBeenCalledWith(false);
});

function checkboxFetchMock() {
  return vi.fn().mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("/docs/checkbox")) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(
        '<ul><li><input data-checkbox-index="0" type="checkbox"> First</li>' +
          '<li><input checked="" data-checkbox-index="1" type="checkbox"> Second</li></ul>',
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    );
  });
}

test("a read-only source renders the doc but never writes a checkbox back", async () => {
  const fetchMock = checkboxFetchMock();
  vi.stubGlobal("fetch", fetchMock);
  const triggerRef = createRef<HTMLElement>();

  render(
    <QueryClientProvider client={makeQueryClient()}>
      <TraceDataSourceProvider
        source={new LocalTraceSource("http://127.0.0.1:4317")}
      >
        <DocViewerSheet
          taskRef="my-task"
          docPath="/work/docs/plan.md"
          triggerRef={triggerRef}
          onOpenChange={() => {}}
        />
      </TraceDataSourceProvider>
    </QueryClientProvider>,
  );
  await screen.findByText("First");

  const [firstBox] = screen.getAllByRole("checkbox") as HTMLInputElement[];
  fireEvent.click(firstBox!);

  expect(firstBox!.checked).toBe(false);
  expect(
    fetchMock.mock.calls.some(([url]) =>
      String(url).includes("/docs/checkbox"),
    ),
  ).toBe(false);
});

test("clicking a checkbox persists the new state to the checkbox endpoint", async () => {
  const fetchMock = checkboxFetchMock();
  vi.stubGlobal("fetch", fetchMock);

  renderSheet("/work/docs/plan.md");
  await screen.findByText("First");

  const [firstBox] = screen.getAllByRole("checkbox");
  fireEvent.click(firstBox!);

  await vi.waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/my-task/docs/checkbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/work/docs/plan.md", index: 0, checked: true }),
    }),
  );
});

test("clicking the line text toggles the line's checkbox, like a label", async () => {
  const fetchMock = checkboxFetchMock();
  vi.stubGlobal("fetch", fetchMock);

  renderSheet("/work/docs/plan.md");
  const label = await screen.findByText("First");

  const [firstBox] = screen.getAllByRole("checkbox") as HTMLInputElement[];
  expect(firstBox!.checked).toBe(false);
  fireEvent.click(label);
  expect(firstBox!.checked).toBe(true); // optimistic flip from the text click

  await vi.waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/my-task/docs/checkbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/work/docs/plan.md", index: 0, checked: true }),
    }),
  );
});

function stubHtmlDoc(html: string) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("/docs/checkbox")) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    writable: true,
    configurable: true,
  });
  return writeText;
}

test("each code block gets a copy button that copies only the code", async () => {
  stubHtmlDoc(
    '<pre><code class="language-sh">eqnx sync\n</code></pre>' +
      "<p>then</p>" +
      "<pre><code>pnpm test\n</code></pre>",
  );
  const writeText = stubClipboard();

  renderSheet("/work/docs/plan.md");
  await screen.findByText("then");

  const buttons = screen.getAllByRole("button", { name: "Copy code" });
  expect(buttons).toHaveLength(2);

  fireEvent.click(buttons[1]!);

  expect(writeText).toHaveBeenCalledWith("pnpm test\n");
  expect(await screen.findByText("Copied")).toBeInTheDocument();
});

test("copying a code block inside a task-list line leaves the checkbox alone", async () => {
  const fetchMock = stubHtmlDoc(
    '<ul><li><input data-checkbox-index="0" type="checkbox"> Run' +
      "<pre><code>pnpm build\n</code></pre></li></ul>",
  );
  const writeText = stubClipboard();

  renderSheet("/work/docs/plan.md");
  await screen.findByText("Run");

  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

  expect(writeText).toHaveBeenCalledWith("pnpm build\n");
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  expect(
    fetchMock.mock.calls.some(([url]) => String(url).includes("/docs/checkbox")),
  ).toBe(false);
});

test("reverts the optimistic checkbox flip when the server rejects", async () => {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("/docs/checkbox")) {
      return Promise.resolve(new Response("boom", { status: 500 }));
    }
    return Promise.resolve(
      new Response('<ul><li><input data-checkbox-index="0" type="checkbox"> First</li></ul>', {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);

  renderSheet("/work/docs/plan.md");
  await screen.findByText("First");

  const box = screen.getByRole("checkbox") as HTMLInputElement;
  fireEvent.click(box);
  expect(box.checked).toBe(true); // optimistic flip

  await vi.waitFor(() => expect(box.checked).toBe(false)); // reverted on error
});

test("does not intercept unknown, external, or non-markdown links", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        [
          '<a href="missing.md">Missing</a>',
          '<a href="https://example.com/plan.md">External</a>',
          '<a href="data.json">Data</a>',
        ].join(" "),
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    ),
  );
  const onNavigateDocRoute = vi.fn();

  renderSheet("/work/docs/plan.md", () => {}, {
    knownDocPaths: ["/work/docs/plan.md", "/work/docs/next.md"],
    onNavigateDocRoute,
  });
  await screen.findByRole("link", { name: "Missing" });

  for (const name of ["Missing", "External", "Data"]) {
    const event = createEvent.click(screen.getByRole("link", { name }), {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    fireEvent(screen.getByRole("link", { name }), event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(onNavigateDocRoute).not.toHaveBeenCalled();
});

test("says where a promoted doc lives in the repo", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("<h1>Plan</h1>", { status: 200, headers: { "content-type": "text/html" } }),
    ),
  );

  renderSheet("/work/docs/plan.md", () => {}, {
    promoted: { repoPath: "docs/plan.md", missing: false },
  });

  expect(await screen.findByRole("heading", { name: "Plan" })).toBeInTheDocument();
  expect(screen.getByTestId("doc-viewer-promoted")).toHaveTextContent(
    "Lives in the project repo at docs/plan.md",
  );
});

test("explains a promoted doc whose repo file is not on this machine", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));

  renderSheet("/work/docs/plan.md", () => {}, {
    promoted: { repoPath: "docs/plan.md", missing: true },
  });

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This document was promoted to docs/plan.md in the project repo, and that file is not on this machine.",
  );
});

test("a promoted doc read from another checkout says so and never writes a checkbox back", async () => {
  const fetchMock = checkboxFetchMock();
  vi.stubGlobal("fetch", fetchMock);

  renderSheet("/work/.worktrees/other/docs/plan.md", () => {}, {
    promoted: {
      repoPath: "docs/plan.md",
      missing: false,
      otherCheckout: "/work/.worktrees/other",
    },
  });
  await screen.findByText("First");

  expect(screen.getByTestId("doc-viewer-promoted")).toHaveTextContent(
    "Read from another checkout at /work/.worktrees/other",
  );

  const [firstBox] = screen.getAllByRole("checkbox") as HTMLInputElement[];
  fireEvent.click(firstBox!);

  expect(firstBox!.checked).toBe(false);
  expect(
    fetchMock.mock.calls.some(([url]) =>
      String(url).includes("/docs/checkbox"),
    ),
  ).toBe(false);
});
