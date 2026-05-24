import { z } from "astro/zod";
import { defineCollection, type SchemaContext } from "astro:content";
import { glob } from "astro/loaders";

function getSchema(params: SchemaContext) {
  return z.object({
    place: z.string(),
    pubDate: z.coerce.date(),
    geo: z.string(),
    image: z.object({
      file: params.image(),
    }),
    tag: z.string(),
  });
}

const fonts = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/fonts" }),
  schema: getSchema,
});

const streetarts = defineCollection({
  loader: glob({ pattern: "**/*.json", base: "./src/content/streetarts" }),
  schema: getSchema,
});

// Export a single `collections` object to register your collection(s)
export const collections = {
  fonts: fonts,
  streetarts: streetarts,
};
