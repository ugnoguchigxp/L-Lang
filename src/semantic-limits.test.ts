import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  parseBoundedJsonText,
  readBoundedJsonFile,
  readBoundedResponseText,
} from "./semantic-limits";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("semantic input limits", () => {
  test("accepts JSON at the byte limit and rejects larger text", () => {
    expect(parseBoundedJsonText('{"a":1}', "fixture", 7)).toEqual({ a: 1 });
    expect(() => parseBoundedJsonText('{"a":10}', "fixture", 7)).toThrow(
      "fixture exceeds 7 bytes",
    );
  });

  test("bounds JSON files before parsing", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "semantic-limits-"));
    temporaryRoots.push(root);
    const path = resolve(root, "fixture.json");
    await writeFile(path, '{"value":true}', "utf8");

    await expect(readBoundedJsonFile(path, "fixture", 14)).resolves.toEqual({
      value: true,
    });
    await expect(readBoundedJsonFile(path, "fixture", 13)).rejects.toThrow(
      "fixture exceeds 13 bytes",
    );
  });

  test("streams response bodies only up to the configured limit", async () => {
    await expect(
      readBoundedResponseText(new Response('{"ok":true}'), "response", 11),
    ).resolves.toBe('{"ok":true}');
    await expect(
      readBoundedResponseText(new Response('{"ok":true}'), "response", 10),
    ).rejects.toThrow("response exceeds 10 bytes");
  });
});
