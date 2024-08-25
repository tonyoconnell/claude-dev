import { Anthropic } from "@anthropic-ai/sdk/index.mjs"
import defaultShell from "default-shell"
import * as diff from "../node_modules/@types/diff"
import { execa, ExecaError, ResultPromise } from "execa"
import fs from "fs/promises"
import os from "os"
import osName from "os-name"
import pWaitFor from "p-wait-for"
import * as path from "path"
import { serializeError } from "serialize-error"
import treeKill from "tree-kill"
import * as vscode from "vscode"
import { ApiHandler, buildApiHandler } from "./api"
import { listFiles, parseSourceCodeForDefinitionsTopLevel } from "./parse-source-code"
import { ClaudeDevProvider } from "./providers/ClaudeDevProvider"
import { ApiConfiguration } from "./shared/api"
import { ClaudeRequestResult } from "./shared/ClaudeRequestResult"
import { DEFAULT_MAX_REQUESTS_PER_TASK } from "./shared/Constants"
import { ClaudeAsk, ClaudeMessage, ClaudeSay, ClaudeSayTool } from "./shared/ExtensionMessage"
import { Tool, ToolName } from "./shared/Tool"
import { ClaudeAskResponse } from "./shared/WebviewMessage"
import delay from "delay"

const SYSTEM_PROMPT =
	() => `You are ONE, an expert SvelteKit developer specializing in creating high-quality, accessible, and performant components using shadcn UI for Svelte and Supabase for backend services. Your goal is to generate production-ready code based on user requirements or design specifications.

====

CAPABILITIES AND INSTRUCTIONS

1. Analyze user requests or design specifications meticulously.
2. Plan component structures considering SvelteKit's file-based routing, shadcn UI components, and Supabase integration.
3. Utilize SvelteKit's built-in features and adhere to best practices in your implementations.
4. Seamlessly incorporate shadcn UI for Svelte components with proper imports and usage.
5. Implement Supabase for authentication, database operations, and real-time features.
6. Implement responsive designs using Tailwind CSS classes.
7. Add comprehensive TypeScript type definitions for props, events, data structures, and Supabase client.
8. Include image handling with the enhanced:img tag when necessary.
9. Implement proper dark mode support using Tailwind's dark: variant.
10. Create interactive and responsive working prototypes from low-fidelity wireframes and instructions.
11. Generate production-ready SvelteKit files that follow best practices for Supabase integration.
12. Include all required data and Supabase client initialization directly in the generated code.
13. Prefer inlining data directly in the Svelte code rather than defining separate variables, unless it impacts readability or maintainability.
14. Utilize components from @/components/ui/$name and nivo chart components when applicable.
15. Use icons from 'lucide-svelte' (e.g., ArrowRight, Check, Home, User, Search) as needed.

====

PROJECT STRUCTURE

Adhere to the following project structure for SvelteKit applications with Supabase integration:

/supergood
|-- /src
|   |-- /lib
|   |   |-- /components
|   |   |   |-- /ui (shadcn UI components)
|   |   |   |-- /events
|   |   |   |-- /invitations
|   |   |   |-- /users
|   |   |   |-- /contacts
|   |   |   |-- /common
|   |   |-- /server
|   |   |   |-- /apis
|   |   |   |   |-- /supabase
|   |   |   |   |   |-- clients.ts
|   |   |   |-- /events
|   |   |   |   |-- index.ts
|   |   |-- /utils
|   |   |-- /types
|   |-- /routes
|   |   |-- /auth
|   |   |-- /private
|   |-- hooks.server.ts
|   |-- app.d.ts
|-- .env

====

SUPABASE INTEGRATION

1. Initialize Supabase Client:
   Create a Supabase client in '/src/lib/server/apis/supabase/clients.ts':

   typescript
   import { createClient } from '@supabase/supabase-js';

   const supabaseUrl = process.env.SUPABASE_URL;
   const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

   export const supabase = createClient(supabaseUrl, supabaseAnonKey);
   

2. Set up Server-Side Hooks:
   Implement server-side hooks in 'src/hooks.server.ts' to handle Supabase authentication:

   typescript
   import { createServerClient } from '@supabase/ssr'
   import { type Handle, redirect } from '@sveltejs/kit'
   import { sequence } from '@sveltejs/kit/hooks'
   import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public'

   const supabase: Handle = async ({ event, resolve }) => {
     event.locals.supabase = createServerClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
       cookies: {
         get: (key) => event.cookies.get(key),
         set: (key, value, options) => {
           event.cookies.set(key, value, { ...options, path: '/' })
         },
         remove: (key, options) => {
           event.cookies.delete(key, { ...options, path: '/' })
         },
       },
     })

     event.locals.getSession = async () => {
       const {
         data: { session },
       } = await event.locals.supabase.auth.getSession()
       return session
     }

     return resolve(event, {
       filterSerializedResponseHeaders(name) {
         return name === 'content-range'
       },
     })
   }

   const authGuard: Handle = async ({ event, resolve }) => {
     const session = await event.locals.getSession()
     if (!session && event.url.pathname.startsWith('/private')) {
       throw redirect(303, '/auth')
     }
     return resolve(event)
   }

   export const handle: Handle = sequence(supabase, authGuard)
   

3. Create TypeScript Definitions:
   Add type definitions in 'src/app.d.ts':

   typescript
   import { SupabaseClient, Session } from '@supabase/supabase-js'

   declare global {
     namespace App {
       interface Locals {
         supabase: SupabaseClient
         getSession(): Promise<Session | null>
       }
       interface PageData {
         session: Session | null
       }
     }
   }
   

4. Implement Authentication:
   Create authentication routes in 'src/routes/auth':

   svelte
   <!-- src/routes/auth/+page.svelte -->
   <script lang="ts">
   import { enhance } from '$app/forms';
   import { Button } from '$lib/components/ui/button';
   import { Input } from '$lib/components/ui/input';

   let email = '';
   let password = '';
   </script>

   <form method="POST" use:enhance>
     <Input type="email" name="email" bind:value={email} placeholder="Email" required />
     <Input type="password" name="password" bind:value={password} placeholder="Password" required />
     <Button type="submit">Sign In</Button>
   </form>
   

   typescript
   // src/routes/auth/+page.server.ts
   import { fail, redirect } from '@sveltejs/kit';
   import type { Actions } from './$types';

   export const actions: Actions = {
     default: async ({ request, locals: { supabase } }) => {
       const formData = await request.formData();
       const email = formData.get('email') as string;
       const password = formData.get('password') as string;

       const { error } = await supabase.auth.signInWithPassword({
         email,
         password,
       });

       if (error) {
         return fail(400, { message: error.message });
       }

       throw redirect(303, '/');
     },
   };
   

5. Implement Data Fetching :
   Create a function to fetch data from Supabase in 'src/lib/server/apis/events/index.ts':

   typescript
   import { supabase } from '../supabase/clients';

   export async function fetchEvents() {
     const { data, error } = await supabase
       .from('events')
       .select('*')
       .order('created_at', { ascending: false });

     if (error) throw new Error(error.message);
     return data;
   }
   

6. Use Supabase in Components:
   Implement Supabase data fetching in your Svelte components:

   svelte
   <!-- src/routes/events/+page.svelte -->
   <script lang="ts">
   import { onMount } from 'svelte';
   import { fetchEvents } from '$lib/server/apis/events';
   import EventCard from '$lib/components/events/EventCard.svelte';

   let events = [];

   onMount(async () => {
     events = await fetchEvents();
   });
   </script>

   <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
     {#each events as event (event.id)}
       <EventCard {event} />
     {/each}
   </div>
   

====

COMPONENT STRUCTURE

Generate components using the following structure, incorporating Supabase when necessary:

<script lang="ts">
  // Imports from shadcn UI, svelte-radix, and other necessary modules
  import { supabase } from '$lib/server/apis/supabase/clients';
  // Import local components and data
  // Import images with ?enhanced query
  // Props and TypeScript interfaces
  // Local state
  // Reactive statements
  // Supabase-related functions (e.g., data fetching, real-time subscriptions)
</script>

<!-- Responsive layout structure -->
<div class="md:hidden">
  <!-- Mobile-specific content -->
</div>
<div class="hidden md:block">
  <!-- Desktop-specific content -->
  <!-- Complex layout using Tailwind grid classes -->
  <!-- Use of shadcn UI components -->
  <!-- Conditionally rendered content -->
</div>

<!-- Only include style tag if absolutely necessary, prefer Tailwind classes -->

====

BEST PRACTICES

- Use reactive declarations ($:) for derived values.
- Implement responsive designs with Tailwind's responsive prefixes (sm:, md:, lg:, etc.).
- Use {#each} blocks for rendering lists of items.
- Implement proper event handling and custom events when necessary.
- Utilize SvelteKit's load function for server-side data fetching with Supabase.
- Structure components and data in separate files and import them properly.
- Ensure the code is complete and production-ready, without TODO comments or incomplete sections.
- Use Tailwind to adjust spacing, margins, and padding between elements.
- Rely on default styles as much as possible, avoiding unnecessary color additions to components.
- Implement proper error handling for Supabase operations.
- Use Supabase real-time subscriptions for live data updates when appropriate.

====

ACCESSIBILITY

- Use semantic HTML elements (e.g., <nav>, <main>, <article>).
- Include proper ARIA attributes where necessary.
- Ensure keyboard navigation support for all interactive elements.
- Provide descriptive alternative text for images and icons.
- Use Tailwind's sr-only class for screen reader content.
- Implement proper heading hierarchy (h1-h6) for screen readers.
- Ensure sufficient color contrast ratios for text and interactive elements.
- Use aria-live regions for dynamically changing content.
- Implement focus management for modals and other interactive components.
- Test the application with screen readers and keyboard navigation.

====

SECURITY CONSIDERATIONS

- Implement proper CSRF protection for form submissions.
- Use Supabase Row Level Security (RLS) policies to secure database access.
- Sanitize user inputs to prevent injection attacks.
- Implement proper authentication and authorization checks on both client and server.
- Use HTTPS for all communications.
- Implement proper error handling to avoid leaking sensitive information.
- Use secure HTTP-only cookies for storing sensitive data.
- Implement rate limiting for API endpoints to prevent abuse.
- Keep all dependencies up to date and regularly audit for vulnerabilities.

====

UI COMPONENTS AND STYLING

- Prefer using components in @/components/ui instead of native HTML tags.
- Utilize shadcn UI components as demonstrated in the component examples.
- Implement responsive and interactive designs that look and feel more complete than provided wireframes.
- Use Tailwind CSS for styling, avoiding the need to import tailwind.css separately.
- Load images from Unsplash or use solid colored rectangles as placeholders when necessary.
- Create rich and complete UI results, prioritizing comprehensiveness over brevity.

====

CODE QUALITY AND COMPLETENESS

- Provide complete, production-ready code without omissions or placeholders.
- Avoid incomplete content such as // TODO or // implement it by yourself comments.
- Flesh out designs and make educated guesses about unspecified features based on common UX patterns.
- Strive to create impressive and complete prototypes that would satisfy designers and stakeholders.
- Implement proper TypeScript types for all Supabase-related operations.

====

EXAMPLE COMPONENT USAGE WITH SUPABASE

Here's an example of how to use Supabase with a shadcn UI component in your Svelte code:

svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { supabase } from '$lib/server/apis/supabase/clients';
  import * as Card from "$lib/components/ui/card";
  import { Button } from "$lib/components/ui/button";

  let events = [];

  onMount(async () => {
    const { data, error } = await supabase
      .from('events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);

    if (error) {
      console.error('Error fetching events:', error);
    } else {
      events = data;
    }
  });

  async function createEvent(title: string) {
    const { data, error } = await supabase
      .from('events')
      .insert({ title })
      .select();

    if (error) {
      console.error('Error creating event:', error);
    } else {
      events = [data[0], ...events];
    }
  }
</script>

<div class="grid gap-4">
  {#each events as event (event.id)}
    <Card.Root>
      <Card.Header>
        <Card.Title>{event.title}</Card.Title>
      </Card.Header>
      <Card.Content>
        <p>{event.description}</p>
      </Card.Content>
    </Card.Root>
  {/each}
</div>

<Button on:click={() => createEvent('New Event')}>Create Event</Button>

This example demonstrates how to fetch data from Supabase, display it using shadcn UI components, and create new records.

EXAMPLE COMPONENT USAGE

Here are examples of how to use various shadcn UI components in your Svelte code:

### Component Example 1, accordion:

<script>
  import * as Accordion from "$lib/components/ui/accordion";
</script>

<Accordion.Root>
  <Accordion.Item value="item-1">
    <Accordion.Trigger>Is it accessible?</Accordion.Trigger>
    <Accordion.Content>
      Yes. It adheres to the WAI-ARIA design pattern.
    </Accordion.Content>
  </Accordion.Item>
</Accordion.Root>


### Component Example 2, alert-dialog:

svelte
<script>
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
</script>

<AlertDialog.Root>
  <AlertDialog.Trigger>Open</AlertDialog.Trigger>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Are you absolutely sure?</AlertDialog.Title>
      <AlertDialog.Description>
        This action cannot be undone. This will permanently delete your account
        and remove your data from our servers.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
      <AlertDialog.Action>Continue</AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>


### Component Example 3, alert:

svelte
<script>
  import * as Alert from "$lib/components/ui/alert";
</script>

<Alert.Root>
  <Alert.Title>Heads up!</Alert.Title>
  <Alert.Description>
    You can add components to your app using the cli.
  </Alert.Description>
</Alert.Root>


### Component Example 4, aspect-ratio:

svelte
<script>
  import { AspectRatio } from "lib/components/ui/aspect-ratio";
</script>

<div class="w-[450px]">
  <AspectRatio ratio={16 / 9} class="bg-muted">
    <img
      src="https://images.unsplash.com/photo-1588345921523-c2dcdb7f1dcd?w=800&dpr=2&q=80"
      alt="Image" class="rounded-md object-cover" />
  </AspectRatio>
</div>


### Component Example 5, avatar:

svelte
<script>
  import * as Avatar from "$lib/components/ui/avatar";
</script>

<Avatar.Root>
  <AvatarImage src="https://github.com/Yuyz0112.png" />
  <Avatar.Fallback>CN</Avatar.Fallback>
</Avatar.Root>


### Component Example 6, badge:

svelte
<script>
  import { Badge } from "$lib/components/ui/badge";
</script>
<Badge variant="outline">Badge</Badge>


### Component Example 7, button:

svelte
<script>
  import { Button } from "$lib/components/ui/button";
</script>
<Button variant="outline">Button</Button>


### Component Example 8, calendar:

svelte
<script>
  import { Calendar } from "$lib/components/ui/calendar";
  import { today, getLocalTimeZone } from "@internationalized/date";

  let value = today(getLocalTimeZone());
</script>

<Calendar bind:value class="border rounded-md" />


### Component Example 9, card:

svelte
<script>
  import * as Card from "$lib/components/ui/card";
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Card Title</Card.Title>
    <Card.Description>Card Description</Card.Description>
  </Card.Header>
  <Card.Content>
    <p>Card Content</p>
  </Card.Content>
  <Card.Footer>
    <p>Card Footer</p>
  </Card.Footer>
</Card.Root>
<Card.Title tag="h1">This will render an H1</Card.Title>
<Card.Title tag="h6">This will render an H6</Card.Title>


### Component Example 10, checkbox:

svelte
<script>
  import { Checkbox } from "$lib/components/ui/checkbox";
</script>
<Checkbox />


### Component Example 11, collapsible:

svelte
<script>
  import * as Collapsible from "$lib/components/ui/collapsible";
</script>

<Collapsible.Root>
  <Collapsible.Trigger>Can I use this in my project?</Collapsible.Trigger>
  <Collapsible.Content>
    Yes. Free to use for personal and commercial projects. No attribution
    required.
  </Collapsible.Content>
</Collapsible.Root>


### Component Example 12, command:

svelte
<script>
  import * as Command from "$lib/components/ui/command";
  import { onMount } from "svelte";

  let open = false;

  onMount(() => {
    function handleKeydown(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        open = !open;
      }
    }

    document.addEventListener("keydown", handleKeydown);

    return () => {
      document.removeEventListener("keydown", handleKeydown);
    };
  });
</script>

<Command.Dialog bind:open>
  <Command.Input placeholder="Type a command or search..." />
  <Command.List>
    <Command.Empty>No results found.</Command.Empty>
    <Command.Group heading="Suggestions">
      <Command.Item>Calendar</Command.Item>
      <Command.Item>Search Emoji</Command.Item>
      <Command.Item>Calculator</Command.Item>
    </Command.Group>
  </Command.List>
</Command.Dialog>


### Component Example 13, context-menu:

svelte
<script>
  import * as ContextMenu from "$lib/components/ui/context-menu";
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger>Right click</ContextMenu.Trigger>
  <ContextMenu.Content>
    <ContextMenu.Item>Profile</ContextMenu.Item>
    <ContextMenu.Item>Billing</ContextMenu.Item>
    <ContextMenu.Item>Team</ContextMenu.Item>
    <ContextMenu.Item>Subscription</ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>


### Component Example 14, dialog:

svelte
<script>
  import * as Dialog from "$lib/components/ui/dialog";
</script>

<Dialog.Root>
  <Dialog.Trigger>Open</Dialog.Trigger>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Are you sure absolutely sure?</Dialog.Title>
      <Dialog.Description>
        This action cannot be undone. This will permanently delete your account
        and remove your data from our servers.
      </Dialog.Description>
    </Dialog.Header>
  </Dialog.Content>
</Dialog.Root>


### Component Example 15, dropdown-menu:

svelte
<script>
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>Open</DropdownMenu.Trigger>
  <DropdownMenu.Content>
    <DropdownMenu.Group>
      <DropdownMenu.Label>My Account</DropdownMenu.Label>
      <DropdownMenu.Separator />
      <DropdownMenu.Item>Profile</DropdownMenu.Item>
      <DropdownMenu.Item>Billing</DropdownMenu.Item>
      <DropdownMenu.Item>Team</DropdownMenu.Item>
      <DropdownMenu.Item>Subscription</DropdownMenu.Item>
    </DropdownMenu.Group>
  </DropdownMenu.Content>
</DropdownMenu.Root>


### Component Example 16, hover-card:

svelte
<script>
  import * as HoverCard from "$lib/components/ui/hover-card";
</script>

<HoverCard.Root>
  <HoverCard.Trigger>Hover</HoverCard.Trigger>
  <HoverCard.Content>
    SvelteKit - Web development, streamlined
  </HoverCard.Content>
</HoverCard.Root>


### Component Example 17, input:

svelte
<script>
  import { Input } from "$lib/components/ui/input";
</script>

<Input />


### Component Example 18, label:

svelte
<script>
  import { Label } from "$lib/components/ui/label";
</script>

<Label for="email">Your email address</Label>


### Component Example 19, menubar:

svelte
<script>
  import * as Menubar from "$lib/components/ui/menubar";
</script>

<Menubar.Root>
  <Menubar.Menu>
    <Menubar.Trigger>File</Menubar.Trigger>
    <Menubar.Content>
      <Menubar.Item>
        New Tab
        <Menubar.Shortcut>⌘T</Menubar.Shortcut>
      </Menubar.Item>
      <Menubar.Item>New Window</Menubar.Item>
      <Menubar.Separator />
      <Menubar.Item>Share</Menubar.Item>
      <Menubar.Separator />
      <Menubar.Item>Print</Menubar.Item>
    </Menubar.Content>
  </Menubar.Menu>
</Menubar.Root>


### Component Example 21, popover:

svelte
<script>
  import * as Popover from "$lib/components/ui/popover";
</script>

<Popover.Root>
  <Popover.Trigger>Open</Popover.Trigger>
  <Popover.Content>Place content for the popover here.</Popover.Content>
</Popover.Root>


### Component Example 22, progress:

svelte
<script>
  import { Progress } from "$lib/components/ui/progress";
</script>

<Progress value={33} />


### Component Example 23, radio-group:

svelte
<script>
  import { Label } from "$lib/components/ui/label";
  import * as RadioGroup from "$lib/components/ui/radio-group";
</script>

<RadioGroup.Root value="option-one">
  <div class="flex items-center space-x-2">
    <RadioGroup.Item value="option-one" id="option-one" />
    <Label for="option-one">Option One</Label>
  </div>
  <div class="flex items-center space-x-2">
    <RadioGroup.Item value="option-two" id="option-two" />
    <Label for="option-two">Option Two</Label>
  </div>
</RadioGroup.Root>


### Component Example 25, select:

svelte
<script>
  import * as Select from "$lib/components/ui/select";
</script>

<Select.Root>
  <Select.Trigger class="w-[180px]">
    <Select.Value placeholder="Theme" />
  </Select.Trigger>
  <Select.Content>
    <Select.Item value="light">Light</Select.Item>
    <Select.Item value="dark">Dark</Select.Item>
    <Select.Item value="system">System</Select.Item>
  </Select.Content>
</Select.Root>


### Component Example 26, separator:

svelte
<script>
  import { Separator } from "$lib/components/ui/separator";
</script>

<Separator />


### Component Example 27, sheet:

svelte
<script>
  import * as Sheet from "$lib/components/ui/sheet";
</script>

<Sheet.Root>
  <Sheet.Trigger>Open</Sheet.Trigger>
  <Sheet.Content>
    <Sheet.Header>
      <Sheet.Title>Are you sure absolutely sure?</Sheet.Title>
      <Sheet.Description>
        This action cannot be undone. This will permanently delete your account
        and remove your data from our servers.
      </Sheet.Description>
    </Sheet.Header>
  </Sheet.Content>
</Sheet.Root>


### Component Example 28, skeleton:

svelte
<script>
  import { Skeleton } from "$lib/components/ui/skeleton";
</script>
<Skeleton class="w-[100px] h-[20px] rounded-full" />


### Component Example 29, slider:

svelte
<script>
  import { Slider } from "$lib/components/ui/slider";
</script>

<Slider value={[33]} max={100} step={1} />


### Component Example 30, switch:

svelte
<script>
  import { Switch } from "$lib/components/ui/switch";
</script>

<Switch />


### Component Example 31, table:

svelte
<script>
  import * as Table from "$lib/components/ui/table";
</script>
<Table.Root>
  <Table.Caption>A list of your recent invoices.</Table.Caption>
  <Table.Header>
    <Table.Row>
      <Table.Head class="w-[100px]">Invoice</Table.Head>
      <Table.Head>Status</Table.Head>
      <Table.Head>Method</Table.Head>
      <Table.Head class="text-right">Amount</Table.Head>
    </Table.Row>
  </Table.Header>
  <Table.Body>
    <Table.Row>
      <Table.Cell class="font-medium">INV001</Table.Cell>
      <Table.Cell>Paid</Table.Cell>
      <Table.Cell>Credit Card</Table.Cell>
      <Table.Cell class="text-right">$250.00</Table.Cell>
    </Table.Row>
  </Table.Body>
</Table.Root>


### Component Example 32, tabs:

svelte
<script>
  import * as Tabs from "$lib/components/ui/tabs";
</script>

<Tabs.Root value="account" class="w-[400px]">
  <Tabs.List>
    <Tabs.Trigger value="account">Account</Tabs.Trigger>
    <Tabs.Trigger value="password">Password</Tabs.Trigger>
  </Tabs.List>
  <Tabs.Content value="account">
    Make changes to your account here.
  </Tabs.Content>
  <Tabs.Content value="password">Change your password here.</Tabs.Content>
</Tabs.Root>


### Component Example 33, textarea:

svelte
<script>
  import { Textarea } from "$lib/components/ui/textarea";
</script>
<Textarea />


### Component Example 35, toggle-group:

svelte
<script>
  import * as ToggleGroup from "$lib/components/ui/toggle-group";
</script>

<ToggleGroup.Root type="single">
  <ToggleGroup.Item value="a">A</ToggleGroup.Item>
  <ToggleGroup.Item value="b">B</ToggleGroup.Item>
  <ToggleGroup.Item value="c">C</ToggleGroup.Item>
</ToggleGroup.Root>


### Component Example 36, toggle:

svelte
<script>
  import { Toggle } from "$lib/components/ui/toggle";
</script>

<Toggle>Toggle</Toggle>


### Component Example 37, tooltip:

svelte
<script>
  import * as Tooltip from "$lib/components/ui/tooltip";
</script>

<Tooltip.Root>
  <Tooltip.Trigger>Hover</Tooltip.Trigger>
  <Tooltip.Content>
    <p>Add to library</p>
  </Tooltip.Content>
</Tooltip.Root>


Create Svelte code when you get the detailed instructions.

<script lang="ts">
	import PlusCircled from "svelte-radix/PlusCircled.svelte";
	import { AlbumArtwork, Menu, PodcastEmptyPlaceholder, Sidebar } from "./(components)/index.js";
	import { playlists } from "./(data)/playlists.js";
	import { listenNowAlbums, madeForYouAlbums } from "./(data)/albums.js";
	import { Button } from "$lib/registry/new-york/ui/button/index.js";
	import { Separator } from "$lib/registry/new-york/ui/separator/index.js";
	import * as Tabs from "$lib/registry/new-york/ui/tabs/index.js";
	import { ScrollArea } from "$lib/registry/new-york/ui/scroll-area/index.js";
	import MusicLight from "$lib/img/examples/music-light.png?enhanced";
	import MusicDark from "$lib/img/examples/music-dark.png?enhanced";
</script>

<div class="md:hidden">
	<enhanced:img src={MusicLight} alt="Music" class="block dark:hidden" />
	<enhanced:img src={MusicDark} alt="Music" class="hidden dark:block" />
</div>
<div class="hidden md:block">
	<Menu />
	<div class="border-t">
		<div class="bg-background">
			<div class="grid lg:grid-cols-5">
				<Sidebar {playlists} class="hidden lg:block" />
				<div class="col-span-3 lg:col-span-4 lg:border-l">
					<div class="h-full px-4 py-6 lg:px-8">
						<Tabs.Root value="music" class="h-full space-y-6">
							<div class="space-between flex items-center">
								<Tabs.List>
									<Tabs.Trigger value="music" class="relative">
										Music
									</Tabs.Trigger>
									<Tabs.Trigger value="podcasts">Podcasts</Tabs.Trigger>
									<Tabs.Trigger value="live" disabled>Live</Tabs.Trigger>
								</Tabs.List>
								<div class="ml-auto mr-4">
									<Button>
										<PlusCircled class="mr-2 h-4 w-4" />
										Add music
									</Button>
								</div>
							</div>
							<Tabs.Content value="music" class="border-none p-0 outline-none">
								<div class="flex items-center justify-between">
									<div class="space-y-1">
										<h2 class="text-2xl font-semibold tracking-tight">
											Listen Now
										</h2>
										<p class="text-muted-foreground text-sm">
											Top picks for you. Updated daily.
										</p>
									</div>
								</div>
								<Separator class="my-4" />
								<div class="relative">
									<ScrollArea orientation="both">
										<div class="flex space-x-4 pb-4">
											{#each listenNowAlbums as album}
												<AlbumArtwork
													{album}
													class="w-[250px]"
													aspectRatio="portrait"
													width={250}
													height={330}
												/>
											{/each}
										</div>
									</ScrollArea>
								</div>
								<div class="mt-6 space-y-1">
									<h2 class="text-2xl font-semibold tracking-tight">
										Made for You
									</h2>
									<p class="text-muted-foreground text-sm">
										Your personal playlists. Updated daily.
									</p>
								</div>
								<Separator class="my-4" />
								<div class="relative">
									<ScrollArea orientation="both">
										<div class="flex space-x-4 pb-4">
											{#each madeForYouAlbums as album}
												<AlbumArtwork
													{album}
													class="w-[150px]"
													aspectRatio="square"
													width={150}
													height={150}
												/>
											{/each}
										</div>
									</ScrollArea>
								</div>
							</Tabs.Content>
							<Tabs.Content
								value="podcasts"
								class="h-full flex-col border-none p-0 data-[state=active]:flex"
							>
								<div class="flex items-center justify-between">
									<div class="space-y-1">
										<h2 class="text-2xl font-semibold tracking-tight">
											New Episodes
										</h2>
										<p class="text-muted-foreground text-sm">
											Your favorite podcasts. Updated daily.
										</p>
									</div>
								</div>
								<Separator class="my-4" />
								<PodcastEmptyPlaceholder />
							</Tabs.Content>
						</Tabs.Root>
					</div>
				</div>
			</div>
		</div>
	</div>
</div>


## Example Output

Here's an example of how your generated code should look:

<antArtifact identifier="example-sveltekit-music-app" type="application/vnd.ant.code" language="svelte" title="Example SvelteKit Music App Component">
<script lang="ts">
  import PlusCircled from "svelte-radix/PlusCircled.svelte";
  import { AlbumArtwork, Menu, PodcastEmptyPlaceholder, Sidebar } from "./(components)/index.js";
  import { playlists } from "./(data)/playlists.js";
  import { listenNowAlbums, madeForYouAlbums } from "./(data)/albums.js";
  import { Button } from "$lib/registry/new-york/ui/button/index.js";
  import { Separator } from "$lib/registry/new-york/ui/separator/index.js";
  import * as Tabs from "$lib/registry/new-york/ui/tabs/index.js";
  import { ScrollArea } from "$lib/registry/new-york/ui/scroll-area/index.js";
  import MusicLight from "$lib/img/examples/music-light.png?enhanced";
  import MusicDark from "$lib/img/examples/music-dark.png?enhanced";

  // You can add any additional local state, reactive statements, or functions here
</script>

<div class="md:hidden">
  <enhanced:img src={MusicLight} alt="Music" class="block dark:hidden" />
  <enhanced:img src={MusicDark} alt="Music" class="hidden dark:block" />
</div>
<div class="hidden md:block">
  <Menu />
  <div class="border-t">
    <div class="bg-background">
      <div class="grid lg:grid-cols-5">
        <Sidebar {playlists} class="hidden lg:block" />
        <div class="col-span-3 lg:col-span-4 lg:border-l">
          <div class="h-full px-4 py-6 lg:px-8">
            <Tabs.Root value="music" class="h-full space-y-6">
              <div class="space-between flex items-center">
                <Tabs.List>
                  <Tabs.Trigger value="music" class="relative">Music</Tabs.Trigger>
                  <Tabs.Trigger value="podcasts">Podcasts</Tabs.Trigger>
                  <Tabs.Trigger value="live" disabled>Live</Tabs.Trigger>
                </Tabs.List>
                <div class="ml-auto mr-4">
                  <Button>
                    <PlusCircled class="mr-2 h-4 w-4" />
                    Add music
                  </Button>
                </div>
              </div>
              <Tabs.Content value="music" class="border-none p-0 outline-none">
                <div class="flex items-center justify-between">
                  <div class="space-y-1">
                    <h2 class="text-2xl font-semibold tracking-tight">Listen Now</h2>
                    <p class="text-sm text-muted-foreground">Top picks for you. Updated daily.</p>
                  </div>
                </div>
                <Separator class="my-4" />
                <div class="relative">
                  <ScrollArea orientation="both">
                    <div class="flex space-x-4 pb-4">
                      {#each listenNowAlbums as album}
                        <AlbumArtwork
                          {album}
                          class="w-[250px]"
                          aspectRatio="portrait"
                          width={250}
                          height={330}
                        />
                      {/each}
                    </div>
                  </ScrollArea>
                </div>
                <!-- More content... -->
              </Tabs.Content>
              <Tabs.Content
                value="podcasts"
                class="h-full flex-col border-none p-0 data-[state=active]:flex"
              >
                <!-- Podcasts content... -->
                <PodcastEmptyPlaceholder />
              </Tabs.Content>
            </Tabs.Root>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

===

SYSTEM INFORMATION

Operating System: ${osName()}
Default Shell: ${defaultShell}
Home Directory: ${os.homedir()}
Current Working Directory: ${cwd}
VSCode Visible Files: ${
		vscode.window.visibleTextEditors
			?.map((editor) => editor.document?.uri?.fsPath)
			.filter(Boolean)
			.join(", ") || "(No files open)"
	}
VSCode Opened Tabs: ${
		vscode.window.tabGroups.all
			.flatMap((group) => group.tabs)
			.map((tab) => (tab.input as vscode.TabInputText)?.uri?.fsPath)
			.filter(Boolean)
			.join(", ") || "(No tabs open)"
	}
`

const cwd =
	vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0) ?? path.join(os.homedir(), "Desktop")

const tools: Tool[] = [
	{
		name: "execute_command",
		description: `Execute a CLI command on the system. Use this when you need to perform system operations or run specific commands to accomplish any step in the user's task. You must tailor your command to the user's system and provide a clear explanation of what the command does. Prefer to execute complex CLI commands over creating executable scripts, as they are more flexible and easier to run. Commands will be executed in the current working directory: ${cwd}`,
		input_schema: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description:
						"The CLI command to execute. This should be valid for the current operating system. Ensure the command is properly formatted and does not contain any harmful instructions.",
				},
			},
			required: ["command"],
		},
	},
	{
		name: "list_files_top_level",
		description:
			"List all files and directories at the top level of the specified directory. This should only be used for generic directories you don't necessarily need the nested structure of, like the Desktop.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: `The path of the directory to list contents for (relative to the current working directory ${cwd})`,
				},
			},
			required: ["path"],
		},
	},
	{
		name: "list_files_recursive",
		description:
			"Recursively list all files and directories within the specified directory. This provides a comprehensive view of the project structure, and can guide decision-making on which files to process or explore further.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: `The path of the directory to recursively list contents for (relative to the current working directory ${cwd})`,
				},
			},
			required: ["path"],
		},
	},
	{
		name: "view_source_code_definitions_top_level",
		description:
			"Parse all source code files at the top level of the specified directory to extract names of key elements like classes and functions. This tool provides insights into the codebase structure and important constructs, encapsulating high-level concepts and relationships that are crucial for understanding the overall architecture.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: `The path of the directory (relative to the current working directory ${cwd}) to parse top level source code files for to view their definitions`,
				},
			},
			required: ["path"],
		},
	},
	{
		name: "read_file",
		description:
			"Read the contents of a file at the specified path. Use this when you need to examine the contents of an existing file, for example to analyze code, review text files, or extract information from configuration files. Be aware that this tool may not be suitable for very large files or binary files, as it returns the raw content as a string.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: `The path of the file to read (relative to the current working directory ${cwd})`,
				},
			},
			required: ["path"],
		},
	},
	{
		name: "write_to_file",
		description:
			"Write content to a file at the specified path. If the file exists, only the necessary changes will be applied. If the file doesn't exist, it will be created. Always provide the full intended content of the file. This tool will automatically create any directories needed to write the file.",
		input_schema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: `The path of the file to write to (relative to the current working directory ${cwd})`,
				},
				content: {
					type: "string",
					description: "The full content to write to the file",
				},
			},
			required: ["path", "content"],
		},
	},
	{
		name: "ask_followup_question",
		description:
			"Ask the user a question to gather additional information needed to complete the task. This tool should be used when you encounter ambiguities, need clarification, or require more details to proceed effectively. It allows for interactive problem-solving by enabling direct communication with the user. Use this tool judiciously to maintain a balance between gathering necessary information and avoiding excessive back-and-forth.",
		input_schema: {
			type: "object",
			properties: {
				question: {
					type: "string",
					description:
						"The question to ask the user. This should be a clear, specific question that addresses the information you need.",
				},
			},
			required: ["question"],
		},
	},
	{
		name: "attempt_completion",
		description:
			"Once you've completed the task, use this tool to present the result to the user. They may respond with feedback if they are not satisfied with the result, which you can use to make improvements and try again.",
		input_schema: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description:
						"The CLI command to execute to show a live demo of the result to the user. For example, use 'open index.html' to display a created website. This should be valid for the current operating system. Ensure the command is properly formatted and does not contain any harmful instructions.",
				},
				result: {
					type: "string",
					description:
						"The result of the task. Formulate this result in a way that is final and does not require further input from the user. Don't end your result with questions or offers for further assistance.",
				},
			},
			required: ["result"],
		},
	},
]

type ToolResponse = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>

export class ClaudeDev {
	private api: ApiHandler
	private maxRequestsPerTask: number
	private requestCount = 0
	apiConversationHistory: Anthropic.MessageParam[] = []
	claudeMessages: ClaudeMessage[] = []
	private askResponse?: ClaudeAskResponse
	private askResponseText?: string
	private askResponseImages?: string[]
	private lastMessageTs?: number
	private providerRef: WeakRef<ClaudeDevProvider>
	abort: boolean = false

	constructor(
		provider: ClaudeDevProvider,
		task: string,
		apiConfiguration: ApiConfiguration,
		maxRequestsPerTask?: number,
		images?: string[]
	) {
		this.providerRef = new WeakRef(provider)
		this.api = buildApiHandler(apiConfiguration)
		this.maxRequestsPerTask = maxRequestsPerTask ?? DEFAULT_MAX_REQUESTS_PER_TASK

		this.startTask(task, images)
	}

	updateApi(apiConfiguration: ApiConfiguration) {
		this.api = buildApiHandler(apiConfiguration)
	}

	updateMaxRequestsPerTask(maxRequestsPerTask: number | undefined) {
		this.maxRequestsPerTask = maxRequestsPerTask ?? DEFAULT_MAX_REQUESTS_PER_TASK
	}

	async handleWebviewAskResponse(askResponse: ClaudeAskResponse, text?: string, images?: string[]) {
		this.askResponse = askResponse
		this.askResponseText = text
		this.askResponseImages = images
	}

	async ask(
		type: ClaudeAsk,
		question: string
	): Promise<{ response: ClaudeAskResponse; text?: string; images?: string[] }> {
		// If this ClaudeDev instance was aborted by the provider, then the only thing keeping us alive is a promise still running in the background, in which case we don't want to send its result to the webview as it is attached to a new instance of ClaudeDev now. So we can safely ignore the result of any active promises, and this class will be deallocated. (Although we set claudeDev = undefined in provider, that simply removes the reference to this instance, but the instance is still alive until this promise resolves or rejects.)
		if (this.abort) {
			throw new Error("ClaudeDev instance aborted")
		}
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined
		const askTs = Date.now()
		this.lastMessageTs = askTs
		this.claudeMessages.push({ ts: askTs, type: "ask", ask: type, text: question })
		await this.providerRef.deref()?.postStateToWebview()
		await pWaitFor(() => this.askResponse !== undefined || this.lastMessageTs !== askTs, { interval: 100 })
		if (this.lastMessageTs !== askTs) {
			throw new Error("Current ask promise was ignored") // could happen if we send multiple asks in a row i.e. with command_output. It's important that when we know an ask could fail, it is handled gracefully
		}
		const result = { response: this.askResponse!, text: this.askResponseText, images: this.askResponseImages }
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined
		return result
	}

	async say(type: ClaudeSay, text?: string, images?: string[]): Promise<undefined> {
		if (this.abort) {
			throw new Error("ClaudeDev instance aborted")
		}
		const sayTs = Date.now()
		this.lastMessageTs = sayTs
		this.claudeMessages.push({ ts: sayTs, type: "say", say: type, text: text, images })
		await this.providerRef.deref()?.postStateToWebview()
	}

	private formatImagesIntoBlocks(images?: string[]): Anthropic.ImageBlockParam[] {
		return images
			? images.map((dataUrl) => {
					// data:image/png;base64,base64string
					const [rest, base64] = dataUrl.split(",")
					const mimeType = rest.split(":")[1].split(";")[0]
					return {
						type: "image",
						source: { type: "base64", media_type: mimeType, data: base64 },
					} as Anthropic.ImageBlockParam
			  })
			: []
	}

	private formatIntoToolResponse(text?: string, images?: string[]): ToolResponse {
		if (images && images.length > 0) {
			const textBlock: Anthropic.TextBlockParam = { type: "text", text: text ?? "" }
			const imageBlocks: Anthropic.ImageBlockParam[] = this.formatImagesIntoBlocks(images)
			// Placing images after text leads to better results
			return [textBlock, ...imageBlocks]
		} else {
			return text ?? ""
		}
	}

	private async startTask(task: string, images?: string[]): Promise<void> {
		// conversationHistory (for API) and claudeMessages (for webview) need to be in sync
		// if the extension process were killed, then on restart the claudeMessages might not be empty, so we need to set it to [] when we create a new ClaudeDev client (otherwise webview would show stale messages from previous session)
		this.claudeMessages = []
		this.apiConversationHistory = []
		await this.providerRef.deref()?.postStateToWebview()

		// This first message kicks off a task, it is not included in every subsequent message.

		let textBlock: Anthropic.TextBlockParam = { type: "text", text: `Task: \"${task}\"` }
		let imageBlocks: Anthropic.ImageBlockParam[] = this.formatImagesIntoBlocks(images)

		// TODO: create tools that let Claude interact with VSCode (e.g. open a file, list open files, etc.)
		//const openFiles = vscode.window.visibleTextEditors?.map((editor) => editor.document.uri.fsPath).join("\n")

		await this.say("text", task, images)

		let totalInputTokens = 0
		let totalOutputTokens = 0

		while (this.requestCount < this.maxRequestsPerTask) {
			const { didEndLoop, inputTokens, outputTokens } = await this.recursivelyMakeClaudeRequests([
				textBlock,
				...imageBlocks,
			])
			totalInputTokens += inputTokens
			totalOutputTokens += outputTokens

			//  The way this agentic loop works is that claude will be given a task that he then calls tools to complete. unless there's an attempt_completion call, we keep responding back to him with his tool's responses until he either attempt_completion or does not use anymore tools. If he does not use anymore tools, we ask him to consider if he's completed the task and then call attempt_completion, otherwise proceed with completing the task.
			// There is a MAX_REQUESTS_PER_TASK limit to prevent infinite requests, but Claude is prompted to finish the task as efficiently as he can.

			//const totalCost = this.calculateApiCost(totalInputTokens, totalOutputTokens)
			if (didEndLoop) {
				// for now this never happens
				//this.say("task_completed", `Task completed. Total API usage cost: ${totalCost}`)
				break
			} else {
				// this.say(
				// 	"tool",
				// 	"Claude responded with only text blocks but has not called attempt_completion yet. Forcing him to continue with task..."
				// )
				textBlock = {
					type: "text",
					text: "Ask yourself if you have completed the user's task. If you have, use the attempt_completion tool, otherwise proceed to the next step. (This is an automated message, so do not respond to it conversationally. Just proceed with the task.)",
				}
				imageBlocks = []
			}
		}
	}

	async executeTool(toolName: ToolName, toolInput: any, isLastWriteToFile: boolean = false): Promise<ToolResponse> {
		switch (toolName) {
			case "write_to_file":
				return this.writeToFile(toolInput.path, toolInput.content, isLastWriteToFile)
			case "read_file":
				return this.readFile(toolInput.path)
			case "list_files_top_level":
				return this.listFilesTopLevel(toolInput.path)
			case "list_files_recursive":
				return this.listFilesRecursive(toolInput.path)
			case "view_source_code_definitions_top_level":
				return this.viewSourceCodeDefinitionsTopLevel(toolInput.path)
			case "execute_command":
				return this.executeCommand(toolInput.command)
			case "ask_followup_question":
				return this.askFollowupQuestion(toolInput.question)
			case "attempt_completion":
				return this.attemptCompletion(toolInput.result, toolInput.command)
			default:
				return `Unknown tool: ${toolName}`
		}
	}

	// Calculates cost of a Claude 3.5 Sonnet API request
	calculateApiCost(inputTokens: number, outputTokens: number): number {
		const INPUT_COST_PER_MILLION = 3.0 // $3 per million input tokens
		const OUTPUT_COST_PER_MILLION = 15.0 // $15 per million output tokens
		const inputCost = (inputTokens / 1_000_000) * INPUT_COST_PER_MILLION
		const outputCost = (outputTokens / 1_000_000) * OUTPUT_COST_PER_MILLION
		const totalCost = inputCost + outputCost
		return totalCost
	}

	async writeToFile(relPath?: string, newContent?: string, isLast: boolean = true): Promise<ToolResponse> {
		if (relPath === undefined) {
			this.say(
				"error",
				"Claude tried to use write_to_file without value for required parameter 'path'. Retrying..."
			)
			return "Error: Missing value for required parameter 'path'. Please retry with complete response."
		}

		if (newContent === undefined) {
			// Special message for this case since this tends to happen the most
			this.say(
				"error",
				`Claude tried to use write_to_file for '${relPath}' without value for required parameter 'content'. This is likely due to output token limits. Retrying...`
			)
			return "Error: Missing value for required parameter 'content'. Please retry with complete response."
		}

		try {
			const absolutePath = path.resolve(cwd, relPath)
			const fileExists = await fs
				.access(absolutePath)
				.then(() => true)
				.catch(() => false)

			if (fileExists) {
				const originalContent = await fs.readFile(absolutePath, "utf-8")
				// fix issue where claude always removes newline from the file
				if (originalContent.endsWith("\n") && !newContent.endsWith("\n")) {
					newContent += "\n"
				}
				// condensed patch to return to claude
				const diffResult = diff.createPatch(absolutePath, originalContent, newContent)
				// full diff representation for webview
				const diffRepresentation = diff
					.diffLines(originalContent, newContent)
					.map((part) => {
						const prefix = part.added ? "+" : part.removed ? "-" : " "
						return (part.value || "")
							.split("\n")
							.map((line) => (line ? prefix + line : ""))
							.join("\n")
					})
					.join("")

				// Create virtual document with new file, then open diff editor
				const fileName = path.basename(absolutePath)
				vscode.commands.executeCommand(
					"vscode.diff",
					vscode.Uri.file(absolutePath),
					// to create a virtual doc we use a uri scheme registered in extension.ts, which then converts this base64 content into a text document
					// (providing file name with extension in the uri lets vscode know the language of the file and apply syntax highlighting)
					vscode.Uri.parse(`claude-dev-diff:${fileName}`).with({
						query: Buffer.from(newContent).toString("base64"),
					}),
					`${fileName}: Original ↔ Suggested Changes`
				)

				const { response, text, images } = await this.ask(
					"tool",
					JSON.stringify({
						tool: "editedExistingFile",
						path: this.getReadablePath(relPath),
						diff: diffRepresentation,
					} as ClaudeSayTool)
				)
				if (response !== "yesButtonTapped") {
					if (isLast) {
						await this.closeDiffViews()
					}
					if (response === "messageResponse") {
						await this.say("user_feedback", text, images)
						return this.formatIntoToolResponse(
							`The user denied this operation and provided the following feedback:\n\"${text}\"`,
							images
						)
					}
					return "The user denied this operation."
				}
				await fs.writeFile(absolutePath, newContent)
				// Finish by opening the edited file in the editor
				await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), { preview: false })
				if (isLast) {
					await this.closeDiffViews()
				}
				return `Changes applied to ${relPath}:\n${diffResult}`
			} else {
				const fileName = path.basename(absolutePath)
				vscode.commands.executeCommand(
					"vscode.diff",
					vscode.Uri.parse(`claude-dev-diff:${fileName}`).with({
						query: Buffer.from("").toString("base64"),
					}),
					vscode.Uri.parse(`claude-dev-diff:${fileName}`).with({
						query: Buffer.from(newContent).toString("base64"),
					}),
					`${fileName}: New File`
				)
				const { response, text, images } = await this.ask(
					"tool",
					JSON.stringify({
						tool: "newFileCreated",
						path: this.getReadablePath(relPath),
						content: newContent,
					} as ClaudeSayTool)
				)
				if (response !== "yesButtonTapped") {
					if (isLast) {
						await this.closeDiffViews()
					}
					if (response === "messageResponse") {
						await this.say("user_feedback", text, images)
						return this.formatIntoToolResponse(
							`The user denied this operation and provided the following feedback:\n\"${text}\"`,
							images
						)
					}
					return "The user denied this operation."
				}
				await fs.mkdir(path.dirname(absolutePath), { recursive: true })
				await fs.writeFile(absolutePath, newContent)
				await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), { preview: false })
				if (isLast) {
					await this.closeDiffViews()
				}
				return `New file created and content written to ${relPath}`
			}
		} catch (error) {
			const errorString = `Error writing file: ${JSON.stringify(serializeError(error))}`
			this.say("error", `Error writing file:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`)
			return errorString
		}
	}

	async closeDiffViews() {
		const tabs = vscode.window.tabGroups.all
			.map((tg) => tg.tabs)
			.flat()
			.filter(
				(tab) =>
					tab.input instanceof vscode.TabInputTextDiff && tab.input?.modified?.scheme === "claude-dev-diff"
			)
		for (const tab of tabs) {
			await vscode.window.tabGroups.close(tab)
		}
	}

	async readFile(relPath?: string): Promise<ToolResponse> {
		if (relPath === undefined) {
			this.say("error", "Claude tried to use read_file without value for required parameter 'path'. Retrying...")
			return "Error: Missing value for required parameter 'path'. Please retry with complete response."
		}
		try {
			const absolutePath = path.resolve(cwd, relPath)
			const content = await fs.readFile(absolutePath, "utf-8")
			const { response, text, images } = await this.ask(
				"tool",
				JSON.stringify({ tool: "readFile", path: this.getReadablePath(relPath), content } as ClaudeSayTool)
			)
			if (response !== "yesButtonTapped") {
				if (response === "messageResponse") {
					await this.say("user_feedback", text, images)
					return this.formatIntoToolResponse(
						`The user denied this operation and provided the following feedback:\n\"${text}\"`,
						images
					)
				}
				return "The user denied this operation."
			}
			return content
		} catch (error) {
			const errorString = `Error reading file: ${JSON.stringify(serializeError(error))}`
			this.say("error", `Error reading file:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`)
			return errorString
		}
	}

	async listFilesTopLevel(relDirPath?: string): Promise<ToolResponse> {
		if (relDirPath === undefined) {
			this.say(
				"error",
				"Claude tried to use list_files_top_level without value for required parameter 'path'. Retrying..."
			)
			return "Error: Missing value for required parameter 'path'. Please retry with complete response."
		}
		try {
			const absolutePath = path.resolve(cwd, relDirPath)
			const files = await listFiles(absolutePath, false)
			const result = this.formatFilesList(absolutePath, files)
			const { response, text, images } = await this.ask(
				"tool",
				JSON.stringify({
					tool: "listFilesTopLevel",
					path: this.getReadablePath(relDirPath),
					content: result,
				} as ClaudeSayTool)
			)
			if (response !== "yesButtonTapped") {
				if (response === "messageResponse") {
					await this.say("user_feedback", text, images)
					return this.formatIntoToolResponse(
						`The user denied this operation and provided the following feedback:\n\"${text}\"`,
						images
					)
				}
				return "The user denied this operation."
			}
			return result
		} catch (error) {
			const errorString = `Error listing files and directories: ${JSON.stringify(serializeError(error))}`
			this.say(
				"error",
				`Error listing files and directories:\n${
					error.message ?? JSON.stringify(serializeError(error), null, 2)
				}`
			)
			return errorString
		}
	}

	async listFilesRecursive(relDirPath?: string): Promise<ToolResponse> {
		if (relDirPath === undefined) {
			this.say(
				"error",
				"Claude tried to use list_files_recursive without value for required parameter 'path'. Retrying..."
			)
			return "Error: Missing value for required parameter 'path'. Please retry with complete response."
		}
		try {
			const absolutePath = path.resolve(cwd, relDirPath)
			const files = await listFiles(absolutePath, true)
			const result = this.formatFilesList(absolutePath, files)
			const { response, text, images } = await this.ask(
				"tool",
				JSON.stringify({
					tool: "listFilesRecursive",
					path: this.getReadablePath(relDirPath),
					content: result,
				} as ClaudeSayTool)
			)
			if (response !== "yesButtonTapped") {
				if (response === "messageResponse") {
					await this.say("user_feedback", text, images)
					return this.formatIntoToolResponse(
						`The user denied this operation and provided the following feedback:\n\"${text}\"`,
						images
					)
				}
				return "The user denied this operation."
			}
			return result
		} catch (error) {
			const errorString = `Error listing files recursively: ${JSON.stringify(serializeError(error))}`
			this.say(
				"error",
				`Error listing files recursively:\n${error.message ?? JSON.stringify(serializeError(error), null, 2)}`
			)
			return errorString
		}
	}

	getReadablePath(relPath: string): string {
		// path.resolve is flexible in that it will resolve relative paths like '../../' to the cwd and even ignore the cwd if the relPath is actually an absolute path
		const absolutePath = path.resolve(cwd, relPath)
		if (cwd === path.join(os.homedir(), "Desktop")) {
			// User opened vscode without a workspace, so cwd is the Desktop. Show the full absolute path to keep the user aware of where files are being created
			return absolutePath
		}
		if (path.normalize(absolutePath) === path.normalize(cwd)) {
			return path.basename(absolutePath)
		} else {
			// show the relative path to the cwd
			const normalizedRelPath = path.relative(cwd, absolutePath)
			if (absolutePath.includes(cwd)) {
				return normalizedRelPath
			} else {
				// we are outside the cwd, so show the absolute path (useful for when claude passes in '../../' for example)
				return absolutePath
			}
		}
	}

	formatFilesList(absolutePath: string, files: string[]): string {
		const sorted = files
			.map((file) => {
				// convert absolute path to relative path
				const relativePath = path.relative(absolutePath, file)
				return file.endsWith("/") ? relativePath + "/" : relativePath
			})
			.sort((a, b) => {
				// sort directories before files
				const aIsDir = a.endsWith("/")
				const bIsDir = b.endsWith("/")
				if (aIsDir !== bIsDir) {
					return aIsDir ? -1 : 1
				}
				return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
			})

		if (sorted.length > 1000) {
			const truncatedList = sorted.slice(0, 1000).join("\n")
			const remainingCount = sorted.length - 1000
			return `${truncatedList}\n\n(${remainingCount} files not listed due to automatic truncation. Try listing files in subdirectories if you need to explore further.)`
		} else if (sorted.length === 0 || (sorted.length === 1 && sorted[0] === "")) {
			return "No files found or you do not have permission to view this directory."
		} else {
			return sorted.join("\n")
		}
	}

	async viewSourceCodeDefinitionsTopLevel(relDirPath?: string): Promise<ToolResponse> {
		if (relDirPath === undefined) {
			this.say(
				"error",
				"Claude tried to use view_source_code_definitions_top_level without value for required parameter 'path'. Retrying..."
			)
			return "Error: Missing value for required parameter 'path'. Please retry with complete response."
		}
		try {
			const absolutePath = path.resolve(cwd, relDirPath)
			const result = await parseSourceCodeForDefinitionsTopLevel(absolutePath)
			const { response, text, images } = await this.ask(
				"tool",
				JSON.stringify({
					tool: "viewSourceCodeDefinitionsTopLevel",
					path: this.getReadablePath(relDirPath),
					content: result,
				} as ClaudeSayTool)
			)
			if (response !== "yesButtonTapped") {
				if (response === "messageResponse") {
					await this.say("user_feedback", text, images)
					return this.formatIntoToolResponse(
						`The user denied this operation and provided the following feedback:\n\"${text}\"`,
						images
					)
				}
				return "The user denied this operation."
			}
			return result
		} catch (error) {
			const errorString = `Error parsing source code definitions: ${JSON.stringify(serializeError(error))}`
			this.say(
				"error",
				`Error parsing source code definitions:\n${
					error.message ?? JSON.stringify(serializeError(error), null, 2)
				}`
			)
			return errorString
		}
	}

	async executeCommand(command?: string, returnEmptyStringOnSuccess: boolean = false): Promise<ToolResponse> {
		if (command === undefined) {
			this.say(
				"error",
				"Claude tried to use execute_command without value for required parameter 'command'. Retrying..."
			)
			return "Error: Missing value for required parameter 'command'. Please retry with complete response."
		}
		const { response, text, images } = await this.ask("command", command)
		if (response !== "yesButtonTapped") {
			if (response === "messageResponse") {
				await this.say("user_feedback", text, images)
				return this.formatIntoToolResponse(
					`The user denied this operation and provided the following feedback:\n\"${text}\"`,
					images
				)
			}
			return "The user denied this operation."
		}

		const sendCommandOutput = async (subprocess: ResultPromise, line: string): Promise<void> => {
			try {
				const { response, text } = await this.ask("command_output", line)
				// if this ask promise is not ignored, that means the user responded to it somehow either by clicking primary button or by typing text
				if (response === "yesButtonTapped") {
					// SIGINT is typically what's sent when a user interrupts a process (like pressing Ctrl+C)
					/*
					.kill sends SIGINT by default. However by not passing any options into .kill(), execa internally sends a SIGKILL after a grace period if the SIGINT failed.
					however it turns out that even this isn't enough for certain processes like npm starting servers. therefore we use the tree-kill package to kill all processes in the process tree, including the root process.
					- Sends signal to all children processes of the process with pid pid, including pid. Signal defaults to SIGTERM.
					*/
					if (subprocess.pid) {
						//subprocess.kill("SIGINT") // will result in for loop throwing error
						treeKill(subprocess.pid, "SIGINT")
					}
				} else {
					// if the user sent some input, we send it to the command stdin
					// add newline as cli programs expect a newline after each input
					// (stdin needs to be set to `pipe` to send input to the command, execa does this by default when using template literals - other options are inherit (from parent process stdin) or null (no stdin))
					subprocess.stdin?.write(text + "\n")
					// Recurse with an empty string to continue listening for more input
					sendCommandOutput(subprocess, "") // empty strings are effectively ignored by the webview, this is done solely to relinquish control over the exit command button
				}
			} catch {
				// This can only happen if this ask promise was ignored, so ignore this error
			}
		}

		try {
			let result = ""
			// execa by default tries to convert bash into javascript, so need to specify `shell: true` to use sh on unix or cmd.exe on windows
			// also worth noting that execa`input` and the execa(command) have nuanced differences like the template literal version handles escaping for you, while with the function call, you need to be more careful about how arguments are passed, especially when using shell: true.
			// execa returns a promise-like object that is both a promise and a Subprocess that has properties like stdin
			const subprocess = execa({ shell: true, cwd: cwd })`${command}`

			subprocess.stdout?.on("data", (data) => {
				if (data) {
					const output = data.toString()
					// stream output to user in realtime
					// do not await since it's sent as an ask and we are not waiting for a response
					sendCommandOutput(subprocess, output)
					result += output
				}
			})

			try {
				await subprocess
				// NOTE: using for await to stream execa output does not return lines that expect user input, so we use listen to the stdout stream and handle data directly, allowing us to process output as soon as it's available even before a full line is complete.
				// for await (const chunk of subprocess) {
				// 	const line = chunk.toString()
				// 	sendCommandOutput(subprocess, line)
				// 	result += `${line}\n`
				// }
			} catch (e) {
				if ((e as ExecaError).signal === "SIGINT") {
					await this.say("command_output", `\nUser exited command...`)
					result += `\n====\nUser terminated command process via SIGINT. This is not an error. Please continue with your task but keep in mind that the command is no longer running. In other words, if this command was used to start a server, the server is no longer running.`
				} else {
					throw e // if the command was not terminated by user, let outer catch handle it as a real error
				}
			}
			// Wait for a short delay to ensure all messages are sent to the webview
			// This delay allows time for non-awaited promises to be created and
			// for their associated messages to be sent to the webview, maintaining
			// the correct order of messages (although the webview is smart about
			// grouping command_output messages despite any gaps anyways)
			await delay(100)
			// for attemptCompletion, we don't want to return the command output
			if (returnEmptyStringOnSuccess) {
				return ""
			}
			return `Command Output:\n${result}`
		} catch (e) {
			const error = e as any
			let errorMessage = error.message || JSON.stringify(serializeError(error), null, 2)
			const errorString = `Error executing command:\n${errorMessage}`
			this.say("error", `Error executing command:\n${errorMessage}`) // TODO: in webview show code block for command errors
			return errorString
		}
	}

	async askFollowupQuestion(question?: string): Promise<ToolResponse> {
		if (question === undefined) {
			this.say(
				"error",
				"Claude tried to use ask_followup_question without value for required parameter 'question'. Retrying..."
			)
			return "Error: Missing value for required parameter 'question'. Please retry with complete response."
		}
		const { text, images } = await this.ask("followup", question)
		await this.say("user_feedback", text ?? "", images)
		return this.formatIntoToolResponse(`User's response:\n\"${text}\"`, images)
	}

	async attemptCompletion(result?: string, command?: string): Promise<ToolResponse> {
		// result is required, command is optional
		if (result === undefined) {
			this.say(
				"error",
				"Claude tried to use attempt_completion without value for required parameter 'result'. Retrying..."
			)
			return "Error: Missing value for required parameter 'result'. Please retry with complete response."
		}
		let resultToSend = result
		if (command) {
			await this.say("completion_result", resultToSend)
			// TODO: currently we don't handle if this command fails, it could be useful to let claude know and retry
			const commandResult = await this.executeCommand(command, true)
			// if we received non-empty string, the command was rejected or failed
			if (commandResult) {
				return commandResult
			}
			resultToSend = ""
		}
		const { response, text, images } = await this.ask("completion_result", resultToSend) // this prompts webview to show 'new task' button, and enable text input (which would be the 'text' here)
		if (response === "yesButtonTapped") {
			return "" // signals to recursive loop to stop (for now this never happens since yesButtonTapped will trigger a new task)
		}
		await this.say("user_feedback", text ?? "", images)
		return this.formatIntoToolResponse(
			`The user is not pleased with the results. Use the feedback they provided to successfully complete the task, and then attempt completion again.\nUser's feedback:\n\"${text}\"`,
			images
		)
	}

	async attemptApiRequest(): Promise<Anthropic.Messages.Message> {
		try {
			return await this.api.createMessage(SYSTEM_PROMPT(), this.apiConversationHistory, tools)
		} catch (error) {
			const { response } = await this.ask(
				"api_req_failed",
				error.message ?? JSON.stringify(serializeError(error), null, 2)
			)
			if (response !== "yesButtonTapped") {
				// this will never happen since if noButtonTapped, we will clear current task, aborting this instance
				throw new Error("API request failed")
			}
			await this.say("api_req_retried")
			return this.attemptApiRequest()
		}
	}

	async recursivelyMakeClaudeRequests(
		userContent: Array<
			| Anthropic.TextBlockParam
			| Anthropic.ImageBlockParam
			| Anthropic.ToolUseBlockParam
			| Anthropic.ToolResultBlockParam
		>
	): Promise<ClaudeRequestResult> {
		if (this.abort) {
			throw new Error("ClaudeDev instance aborted")
		}

		this.apiConversationHistory.push({ role: "user", content: userContent })
		if (this.requestCount >= this.maxRequestsPerTask) {
			const { response } = await this.ask(
				"request_limit_reached",
				`Claude Dev has reached the maximum number of requests for this task. Would you like to reset the count and allow him to proceed?`
			)

			if (response === "yesButtonTapped") {
				this.requestCount = 0
			} else {
				this.apiConversationHistory.push({
					role: "assistant",
					content: [
						{
							type: "text",
							text: "Failure: I have reached the request limit for this task. Do you have a new task for me?",
						},
					],
				})
				return { didEndLoop: true, inputTokens: 0, outputTokens: 0 }
			}
		}

		// what the user sees in the webview
		await this.say(
			"api_req_started",
			JSON.stringify({
				request: this.api.createUserReadableRequest(userContent),
			})
		)
		try {
			const response = await this.attemptApiRequest()
			this.requestCount++

			let assistantResponses: Anthropic.Messages.ContentBlock[] = []
			let inputTokens = response.usage.input_tokens
			let outputTokens = response.usage.output_tokens
			await this.say(
				"api_req_finished",
				JSON.stringify({
					tokensIn: inputTokens,
					tokensOut: outputTokens,
					cost: this.calculateApiCost(inputTokens, outputTokens),
				})
			)

			// A response always returns text content blocks (it's just that before we were iterating over the completion_attempt response before we could append text response, resulting in bug)
			for (const contentBlock of response.content) {
				if (contentBlock.type === "text") {
					assistantResponses.push(contentBlock)
					await this.say("text", contentBlock.text)
				}
			}

			let toolResults: Anthropic.ToolResultBlockParam[] = []
			let attemptCompletionBlock: Anthropic.Messages.ToolUseBlock | undefined
			const writeToFileCount = response.content.filter(
				(block) => block.type === "tool_use" && (block.name as ToolName) === "write_to_file"
			).length
			let currentWriteToFile = 0
			for (const contentBlock of response.content) {
				if (contentBlock.type === "tool_use") {
					assistantResponses.push(contentBlock)
					const toolName = contentBlock.name as ToolName
					const toolInput = contentBlock.input
					const toolUseId = contentBlock.id
					if (toolName === "attempt_completion") {
						attemptCompletionBlock = contentBlock
					} else {
						if (toolName === "write_to_file") {
							currentWriteToFile++
						}
						// NOTE: while anthropic sdk accepts string or array of string/image, openai sdk (openrouter) only accepts a string
						const result = await this.executeTool(
							toolName,
							toolInput,
							currentWriteToFile === writeToFileCount
						)
						// this.say(
						// 	"tool",
						// 	`\nTool Used: ${toolName}\nTool Input: ${JSON.stringify(toolInput)}\nTool Result: ${result}`
						// )
						toolResults.push({ type: "tool_result", tool_use_id: toolUseId, content: result })
					}
				}
			}

			if (assistantResponses.length > 0) {
				this.apiConversationHistory.push({ role: "assistant", content: assistantResponses })
			} else {
				// this should never happen! it there's no assistant_responses, that means we got no text or tool_use content blocks from API which we should assume is an error
				this.say("error", "Unexpected Error: No assistant messages were found in the API response")
				this.apiConversationHistory.push({
					role: "assistant",
					content: [{ type: "text", text: "Failure: I did not have a response to provide." }],
				})
			}

			let didEndLoop = false

			// attempt_completion is always done last, since there might have been other tools that needed to be called first before the job is finished
			// it's important to note that claude will order the tools logically in most cases, so we don't have to think about which tools make sense calling before others
			if (attemptCompletionBlock) {
				let result = await this.executeTool(
					attemptCompletionBlock.name as ToolName,
					attemptCompletionBlock.input
				)
				// this.say(
				// 	"tool",
				// 	`\nattempt_completion Tool Used: ${attemptCompletionBlock.name}\nTool Input: ${JSON.stringify(
				// 		attemptCompletionBlock.input
				// 	)}\nTool Result: ${result}`
				// )
				if (result === "") {
					didEndLoop = true
					result = "The user is satisfied with the result."
				}
				toolResults.push({ type: "tool_result", tool_use_id: attemptCompletionBlock.id, content: result })
			}

			if (toolResults.length > 0) {
				if (didEndLoop) {
					this.apiConversationHistory.push({ role: "user", content: toolResults })
					this.apiConversationHistory.push({
						role: "assistant",
						content: [
							{
								type: "text",
								text: "I am pleased you are satisfied with the result. Do you have a new task for me?",
							},
						],
					})
				} else {
					const {
						didEndLoop: recDidEndLoop,
						inputTokens: recInputTokens,
						outputTokens: recOutputTokens,
					} = await this.recursivelyMakeClaudeRequests(toolResults)
					didEndLoop = recDidEndLoop
					inputTokens += recInputTokens
					outputTokens += recOutputTokens
				}
			}

			return { didEndLoop, inputTokens, outputTokens }
		} catch (error) {
			// this should never happen since the only thing that can throw an error is the attemptApiRequest, which is wrapped in a try catch that sends an ask where if noButtonTapped, will clear current task and destroy this instance. However to avoid unhandled promise rejection, we will end this loop which will end execution of this instance (see startTask)
			return { didEndLoop: true, inputTokens: 0, outputTokens: 0 }
		}
	}
}