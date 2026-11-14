// Marketplace publication policy, deliberately separate from the SDK's client-install rules.
// Call only after the package passed inspectPackage; never apply to historical re-admission.

/** Exact published identity/version/bytes, including versions recovered from the baseline history. */
export function isPublishedPackage(entry, baseline) {
  const before = baseline.shards.get(`plugins/${entry.pluginId}/${entry.version}.json`);
  return before?.pluginId === entry.pluginId && before.version === entry.version
    && before.contentHash === entry.contentHash;
}

/** Complete English and Chinese setting text is required only for new marketplace publications. */
export function validatePublicationLocalizations(manifest) {
  const errors = [];
  for (const field of manifest.settings ?? []) {
    const localizations = Object.entries(field.localizations ?? {});
    for (const locale of ["en", "zh"]) {
      const text = localizations.find(([key]) => key.toLowerCase() === locale)?.[1];
      const where = `setting '${field.key}' localizations.${locale}`;
      const requireText = (key, value) => {
        if (typeof value !== "string" || value.trim() === "") {
          errors.push(`${where}.${key}: 新上架及更新须提供非空译文 / new publications and updates require non-blank text`);
        }
      };
      requireText("title", text?.title);
      if (typeof field.description === "string" && field.description.trim() !== "") {
        requireText("description", text?.description);
      }
      if (typeof field.helperLabel === "string" && field.helperLabel.trim() !== "") {
        requireText("helperLabel", text?.helperLabel);
      }
      for (const option of field.options ?? []) {
        const label = text?.options && Object.hasOwn(text.options, option.value)
          ? text.options[option.value] : undefined;
        requireText(`options[${JSON.stringify(option.value)}]`, label);
      }
    }
  }
  return errors;
}
