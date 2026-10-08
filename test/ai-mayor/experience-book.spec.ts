import { distanceBand, ExperienceBook, optionFamily } from "../../src/main/services/ai-mayor/v2/experience-book";
import { remedyFamily } from "../../src/main/services/ai-mayor/v2/road-care";

describe("the recorder's experience: what passed and helped orders the next candidates, nothing else", () => {
  test("without evidence the built-in order stands", () => {
    const book = new ExperienceBook();
    expect(book.rank("access-road", "d<30", ["a", "b", "c"], (item) => item)).toEqual(["a", "b", "c"]);
    book.record("access-road", "d<30", "b", "OK");
    expect(book.rank("access-road", "d<30", ["a", "b", "c"], (item) => item)).toEqual(["a", "b", "c"]);
  });
  test("a kind of answer that kept passing goes first, one the game kept refusing goes last; new ones keep the middle", () => {
    const book = new ExperienceBook();
    for (let i = 0; i < 3; i += 1) { book.record("access-road", "d<30", "c", "OK"); book.record("access-road", "d<30", "a", "REFUSED"); }
    expect(book.rank("access-road", "d<30", ["a", "b", "c"], (item) => item)).toEqual(["c", "b", "a"]);
  });
  test("evidence from another condition is used when this one has none", () => {
    const book = new ExperienceBook();
    for (let i = 0; i < 3; i += 1) book.record("utility-link", "electricity:d<80", "street0:skew", "OK");
    expect(book.rank("utility-link", "electricity:d<30", ["street0:square", "street0:skew"], (item) => item)[0]).toBe("street0:skew");
  });
  test("a traffic change that made things worse scores below one that helped", () => {
    const book = new ExperienceBook();
    for (let i = 0; i < 3; i += 1) { book.record("traffic", "street", "control:lights", "WORSE"); book.record("traffic", "street", "control:nolights", "IMPROVED"); }
    expect(book.score("traffic", "street", "control:lights")!).toBeLessThan(0.25);
    expect(book.score("traffic", "street", "control:nolights")!).toBeGreaterThan(0.75);
  });
  test("it persists through its store and stays bounded", () => {
    let saved: Record<string, unknown> | null = null;
    const store = { load: () => saved as never, save: (data: Record<string, unknown>) => { saved = JSON.parse(JSON.stringify(data)); } };
    const book = new ExperienceBook(store);
    for (let i = 0; i < 700; i += 1) book.record("k", `c${i}`, "o", "OK");
    expect(Object.keys(saved!).length).toBe(600);
    expect(new ExperienceBook(store).snapshot()["k|c699|o"]?.ok).toBe(1);
  });
  test("labels become kinds: numbers out; distances become bands; trial keys become remedy kinds", () => {
    expect(optionFamily("short:42m:reach:1")).toBe(optionFamily("short:17m:reach:1"));
    expect(distanceBand(12)).toBe("d<30");
    expect(distanceBand(200)).toBe("d>=160");
    expect(remedyFamily("control:123:4:nolights")).toBe("control:nolights");
    expect(remedyFamily("feed:55:1")).toBe("feed");
  });
});