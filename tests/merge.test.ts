import { describe, expect, it } from "vitest";
import { buildContext, renderTemplate } from "@/lib/merge";

describe("renderTemplate", () => {
  const ctx = buildContext({
    buyer: { name: "Alice Smith", email: "alice@example.com", phone: "+1", role: "PRIMARY" },
    lot: { lotNumber: "42", address: "1 Oak", status: "NEW" },
    project: { name: "Maple Heights" },
    rep: { name: "Bob", email: "bob@example.com", phone: "+2" },
  });

  it("replaces tags", () => {
    expect(renderTemplate("Hi {{buyer.firstName}}, lot {{lot.lotNumber}}", ctx)).toBe(
      "Hi Alice, lot 42"
    );
  });

  it("supports multiple tags", () => {
    expect(
      renderTemplate("{{project.name}} {{rep.name}} {{buyer.email}}", ctx)
    ).toBe("Maple Heights Bob alice@example.com");
  });

  it("returns empty string for missing context values", () => {
    const partial = buildContext({
      buyer: { name: "Solo", email: null, phone: null, role: "PRIMARY" },
      lot: { lotNumber: "1", address: null, status: "NEW" },
      project: { name: "P" },
      rep: null,
    });
    expect(renderTemplate("[{{rep.name}}] [{{buyer.email}}]", partial)).toBe("[] []");
  });

  it("ignores unknown object keys", () => {
    expect(renderTemplate("{{unknown.field}}", ctx)).toBe("");
  });
});
