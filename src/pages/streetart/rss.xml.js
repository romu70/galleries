import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context) {
  const saAll = await getCollection('streetarts');

  return rss({
    title: 'Street Art Gallery',
    description: 'Galleries of nice street art paintings found in real life.',
    site: context.site,
    items: saAll.map((sa) => ({
      title: sa.data.image.alt + ", " + sa.data.place,
      pubDate: sa.data.pubDate,
      link: context.site.href
    })),
  });
}