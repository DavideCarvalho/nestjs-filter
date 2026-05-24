export default new Map([
  [
    'src/content/docs/getting-started/index.mdx',
    () =>
      import(
        'astro:content-layer-deferred-module?astro%3Acontent-layer-deferred-module=&fileName=src%2Fcontent%2Fdocs%2Fgetting-started%2Findex.mdx&astroContentModuleFlag=true'
      ),
  ],
  [
    'src/content/docs/guides/controllers.mdx',
    () =>
      import(
        'astro:content-layer-deferred-module?astro%3Acontent-layer-deferred-module=&fileName=src%2Fcontent%2Fdocs%2Fguides%2Fcontrollers.mdx&astroContentModuleFlag=true'
      ),
  ],
  [
    'src/content/docs/guides/filter-classes.mdx',
    () =>
      import(
        'astro:content-layer-deferred-module?astro%3Acontent-layer-deferred-module=&fileName=src%2Fcontent%2Fdocs%2Fguides%2Ffilter-classes.mdx&astroContentModuleFlag=true'
      ),
  ],
  [
    'src/content/docs/guides/relations.mdx',
    () =>
      import(
        'astro:content-layer-deferred-module?astro%3Acontent-layer-deferred-module=&fileName=src%2Fcontent%2Fdocs%2Fguides%2Frelations.mdx&astroContentModuleFlag=true'
      ),
  ],
  [
    'src/content/docs/guides/repositories.mdx',
    () =>
      import(
        'astro:content-layer-deferred-module?astro%3Acontent-layer-deferred-module=&fileName=src%2Fcontent%2Fdocs%2Fguides%2Frepositories.mdx&astroContentModuleFlag=true'
      ),
  ],
  [
    'src/content/docs/guides/testing.mdx',
    () =>
      import(
        'astro:content-layer-deferred-module?astro%3Acontent-layer-deferred-module=&fileName=src%2Fcontent%2Fdocs%2Fguides%2Ftesting.mdx&astroContentModuleFlag=true'
      ),
  ],
  [
    'src/content/docs/guides/validation.mdx',
    () =>
      import(
        'astro:content-layer-deferred-module?astro%3Acontent-layer-deferred-module=&fileName=src%2Fcontent%2Fdocs%2Fguides%2Fvalidation.mdx&astroContentModuleFlag=true'
      ),
  ],
  [
    'src/content/docs/index.mdx',
    () =>
      import(
        'astro:content-layer-deferred-module?astro%3Acontent-layer-deferred-module=&fileName=src%2Fcontent%2Fdocs%2Findex.mdx&astroContentModuleFlag=true'
      ),
  ],
]);
