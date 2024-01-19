import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context) {
  const fonts = await getCollection('fonts');
  console.log(context.site);

  return rss({
    title: 'Galleries',
    description: 'Galleries of nice things found in real life.',
    site: context.site,
    items: fonts.map((font) => ({
      title: font.data.image.alt + ", " + font.data.place,
      pubDate: font.data.pubDate,
      link: context.site.href
    })),
  });
}