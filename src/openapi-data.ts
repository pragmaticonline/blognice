export const OPENAPI_YAML = `openapi: 3.1.0
info:
  title: Blognice API
  version: 1.0.0
  description: Token-protected API for managing blogs, posts, pages, and media on Blognice. Custom domains are managed in Blog Settings → Domains (no API keys). Base URL https://www.blognice.com — see docs/API.md for human reference.
  contact:
    name: Blognice
    url: https://blognice.com
    email: press@blognice.com
  license:
    name: MIT
    url: https://github.com/pragmaticonline/blognice/blob/main/LICENSE
servers:
  - url: https://www.blognice.com
    description: Production
  - url: https://blognice.com
    description: Production (apex)
  - url: http://localhost:8787
    description: Local wrangler dev
security:
  - bearerAuth: []
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
  schemas:
    Blog:
      type: object
      properties:
        public_id: { type: string, example: ggh6gvgsgj4h }
        slug: { type: string, example: myblog }
        title: { type: string }
        description: { type: string }
        footer_name: { type: string }
        accent_color: { type: string, pattern: '^#[0-9a-f]{6}$', example: '#1a8917' }
        topics: { type: array, items: { type: string }, maxItems: 10 }
        social_links: { type: object, additionalProperties: { type: string } }
        navigation_links: { type: array, items: { $ref: '#/components/schemas/NavigationLink' }, maxItems: 20 }
        header_link_url: { type: string, description: 'Where header logo/title links — / or https://', example: https://www.domain.com }
        browser_push_enabled: { type: boolean }
        custom_domain: { type: string, nullable: true }
        created_at: { type: integer }
        role: { type: string, enum: [owner, admin, editor, author] }
    NavigationLink:
      type: object
      required: [label, href]
      properties:
        label: { type: string, maxLength: 40 }
        href: { type: string, maxLength: 200, description: 'https://... or /path' }
        order: { type: integer, minimum: 0, maximum: 999 }
    Page:
      type: object
      properties:
        id: { type: integer }
        slug: { type: string }
        title: { type: string }
        body_md: { type: string }
        published: { type: boolean }
        show_in_navigation: { type: boolean }
        navigation_label: { type: string, nullable: true }
        navigation_order: { type: integer }
        meta_description: { type: string, nullable: true }
        created_at: { type: integer }
        updated_at: { type: integer }
        published_at: { type: integer, nullable: true }
    Post:
      type: object
      properties:
        id: { type: integer }
        slug: { type: string }
        title: { type: string }
        body_md: { type: string }
        tags: { type: array, items: { type: string } }
        featured_image_key: { type: string, nullable: true }
        author_name: { type: string, nullable: true }
        author_visible: { type: boolean }
        published: { type: boolean }
        meta_description: { type: string, nullable: true }
    Error:
      type: object
      properties:
        error: { type: string }
paths:
  /api/v1/me:
    get:
      summary: List your blogs
      operationId: getMe
      responses:
        '200': { description: OK, content: { application/json: { schema: { type: object, properties: { id: { type: integer }, email: { type: string }, blogs: { type: array, items: { type: object, properties: { public_id: { type: string }, slug: { type: string }, title: { type: string } } } } } } } } }
        '401': { $ref: '#/components/responses/Unauthorized' }
  /api/v1/blogs:
    post:
      summary: Create a blog
      operationId: createBlog
      requestBody: { required: true, content: { application/json: { schema: { type: object, required: [slug, title], properties: { slug: { type: string }, title: { type: string }, description: { type: string } } } } } }
      responses:
        '201': { description: Created, content: { application/json: { schema: { type: object, properties: { blog: { $ref: '#/components/schemas/Blog' } } } } } }
        '409': { description: Limit reached }
  /api/v1/blogs/{blogId}:
    get:
      summary: Get blog settings
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }]
      responses:
        '200': { description: OK, content: { application/json: { schema: { type: object, properties: { blog: { $ref: '#/components/schemas/Blog' } } } } } }
    patch:
      summary: Update blog settings (navigation_links, header_link_url, etc.)
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                slug: { type: string }
                title: { type: string }
                description: { type: string }
                footer_name: { type: string }
                accent_color: { type: string }
                topics: { type: array, items: { type: string } }
                social_links: { type: object }
                navigation_links: { type: array, items: { $ref: '#/components/schemas/NavigationLink' } }
                header_link_url: { type: string, description: Where header logo/title links — / or https:// }
                browser_push_enabled: { type: boolean }
      responses:
        '200': { description: OK, content: { application/json: { schema: { type: object, properties: { blog: { $ref: '#/components/schemas/Blog' } } } } } }
  /api/v1/blogs/{blogId}/posts:
    get:
      summary: List posts
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }]
      responses: { '200': { description: OK } }
    post:
      summary: Create post
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [title, body_md]
              properties:
                title: { type: string }
                body_md: { type: string }
                slug: { type: string }
                published: { type: boolean }
                tags: { type: array, items: { type: string } }
                author_name: { type: string, nullable: true }
                author_visible: { type: boolean }
                featured_image_key: { type: string, nullable: true }
                meta_description: { type: string }
      responses: { '201': { description: Created } }
  /api/v1/blogs/{blogId}/posts/{id}:
    get:
      summary: Get post
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }, { name: id, in: path, required: true, schema: { type: integer } }]
      responses: { '200': { description: OK } }
    patch:
      summary: Update post
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }, { name: id, in: path, required: true, schema: { type: integer } }]
      requestBody: { required: true, content: { application/json: { schema: { type: object, properties: { title: { type: string }, body_md: { type: string }, slug: { type: string }, published: { type: boolean }, tags: { type: array, items: { type: string } }, author_name: { type: string, nullable: true }, author_visible: { type: boolean }, featured_image_key: { type: string, nullable: true }, meta_description: { type: string } } } } } }
      responses: { '200': { description: OK } }
    delete:
      summary: Delete post
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }, { name: id, in: path, required: true, schema: { type: integer } }]
      responses: { '200': { description: OK } }
  /api/v1/blogs/{blogId}/indexnow:
    post:
      summary: Re-queue IndexNow discovery
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }]
      requestBody: { required: false, content: { application/json: { schema: { type: object, properties: { post_ids: { type: array, items: { type: integer } }, paths: { type: array, items: { type: string } } } } } } }
      responses: { '200': { description: Queued } }
  /api/v1/blogs/{blogId}/pages:
    get:
      summary: List pages
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }]
      responses: { '200': { description: OK, content: { application/json: { schema: { type: object, properties: { pages: { type: array, items: { $ref: '#/components/schemas/Page' } } } } } } } }
    post:
      summary: Create page
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [title]
              properties:
                title: { type: string, maxLength: 200 }
                body_md: { type: string }
                slug: { type: string }
                published: { type: boolean }
                show_in_navigation: { type: boolean }
                navigation_label: { type: string }
                navigation_order: { type: integer }
                meta_description: { type: string }
      responses: { '201': { description: Created } }
  /api/v1/blogs/{blogId}/pages/{id}:
    get:
      summary: Get page
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }, { name: id, in: path, required: true, schema: { type: integer } }]
      responses: { '200': { description: OK } }
    patch:
      summary: Update page
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }, { name: id, in: path, required: true, schema: { type: integer } }]
      requestBody: { required: true, content: { application/json: { schema: { type: object, properties: { title: { type: string }, body_md: { type: string }, slug: { type: string }, published: { type: boolean }, show_in_navigation: { type: boolean }, navigation_label: { type: string }, navigation_order: { type: integer }, meta_description: { type: string } } } } } }
      responses: { '200': { description: OK } }
    delete:
      summary: Delete page
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }, { name: id, in: path, required: true, schema: { type: integer } }]
      responses: { '200': { description: OK } }
  /api/v1/blogs/{blogId}/media:
    get: { summary: List media, parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }], responses: { '200': { description: OK } } }
    post:
      summary: Upload media
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }]
      requestBody: { required: true, content: { multipart/form-data: { schema: { type: object, properties: { file: { type: string, format: binary } } } } } }
      responses: { '200': { description: OK } }
    delete:
      summary: Delete media
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }, { name: key, in: query, required: true, schema: { type: string } }]
      responses: { '200': { description: OK } }
  /api/v1/blogs/{blogId}/images/generations:
    post:
      summary: Generate image (async)
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }]
      requestBody: { required: true, content: { application/json: { schema: { type: object, properties: { prompt: { type: string }, post_id: { type: integer }, style: { type: string, enum: [editorial-photo, editorial-illustration, cinematic, child-crayon, arcade-action, risograph, paper-collage, watercolor, minimal, auto] } } } } } }
      responses: { '202': { description: Queued } }
  /api/v1/blogs/{blogId}/images/generations/{jobId}:
    get:
      summary: Poll image generation
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }, { name: jobId, in: path, required: true, schema: { type: string } }]
      responses: { '200': { description: OK } }
  /api/v1/blogs/{blogId}/posts/{id}/audio/generations:
    post:
      summary: Generate narration
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }, { name: id, in: path, required: true, schema: { type: integer } }]
      responses: { '202': { description: Queued } }
  /api/v1/blogs/{blogId}/audio/generations/{jobId}:
    get:
      summary: Poll audio generation
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }, { name: jobId, in: path, required: true, schema: { type: string } }]
      responses: { '200': { description: OK } }
  /api/v1/blogs/{blogId}/posts/{id}/audio:
    delete:
      summary: Remove narration
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }, { name: id, in: path, required: true, schema: { type: integer } }]
      responses: { '200': { description: OK } }
  /api/v1/blogs/{blogId}/metrics:
    get:
      summary: Metrics (7/30/90d)
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }, { name: days, in: query, schema: { type: integer, enum: [7,30,90] } }]
      responses: { '200': { description: OK } }
  /api/v1/blogs/{blogId}/tags:
    get:
      summary: Tag cloud
      parameters: [{ name: blogId, in: path, required: true, schema: { type: string } }]
      responses: { '200': { description: OK } }
components:
  responses:
    Unauthorized: { description: Unauthorized, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
`;
