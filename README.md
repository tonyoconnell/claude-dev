# ONE: AI-Powered SvelteKit & Supabase Development Assistant

ONE is your AI companion for building robust, full-stack applications with SvelteKit and Supabase. Emphasizing test-first development, ONE helps you create maintainable, efficient code from project inception to deployment.

[![VS Code Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/ONEIE.onedotieblockbuilder)](https://marketplace.visualstudio.com/items?itemName=ONEIE.onedotieblockbuilder)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Twitter Follow](https://img.shields.io/twitter/follow/one_vscode?style=social)](https://twitter.com/one_vscode)

## Quick Start

1. Install ONE from the [VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=ONEIE.onedotieblockbuilder)
2. Click the ONE icon in the VSCode sidebar
3. In the ONE panel, click on "Settings"
4. Add your API key in the provided input field:
   - Anthropic (Claude)
   - OpenRouter
   - AWS Bedrock
5. Click "Save" to store your API key securely
6. Use the "New Chat" button to start coding with AI assistance

## Built on the Work of Giants

ONE stands on the shoulders of giants, leveraging the power of:

- [SvelteKit](https://kit.svelte.dev/): The fastest way to build Svelte apps
- [Supabase](https://supabase.com/): The open-source Firebase alternative
- [TypeScript](https://www.typescriptlang.org/): Typed JavaScript at any scale
- [Anthropic](https://www.anthropic.com/): Cutting-edge AI models

We're deeply grateful to these projects and their communities for making ONE possible.

## Emphasizing Test-First Development

ONE encourages a test-first approach to ensure robust, well-designed code. Always begin your development process with tests to define expected behavior and guide implementation.

## Practical Prompt Examples

### 1. Setting Up a SvelteKit Project with Supabase

```
Let's set up a new SvelteKit project with Supabase integration:

1. Initialize a new SvelteKit project with TypeScript
2. Write a test for Supabase connection and authentication
3. Implement Supabase client setup and basic authentication
4. Create a test for a user profile page that requires authentication
5. Implement the user profile page component
6. Add Playwright E2E tests for the authentication flow
```

### 2. Building a Real-Time Chat Feature

```
We need to add a real-time chat feature to our SvelteKit app using Supabase:

1. Start with unit tests for message sending and receiving functions
2. Implement these functions using Supabase's real-time capabilities
3. Create a Svelte component for the chat interface
4. Write component tests for the chat UI
5. Implement real-time updates in the component
6. Create E2E tests for the entire chat feature
7. Add error handling and offline support
```

### 3. Implementing Serverless Functions with Supabase Edge Functions

```
Let's create serverless functions using Supabase Edge Functions:

1. Write tests for a serverless function that processes data
2. Implement the Edge Function in TypeScript
3. Create a SvelteKit endpoint that calls this Edge Function
4. Write integration tests for the SvelteKit endpoint
5. Implement error handling and logging
6. Add authentication to the Edge Function
7. Create E2E tests that cover the entire flow from frontend to Edge Function
```

### 4. Developing an Admin Dashboard

```
We need to create an admin dashboard for our SvelteKit and Supabase app:

1. Begin with tests for admin authentication and authorization
2. Implement admin auth using Supabase Row Level Security (RLS)
3. Write tests for fetching and displaying user analytics
4. Create Svelte components for various dashboard widgets
5. Implement data fetching and real-time updates using Supabase
6. Add tests for admin actions (e.g., user management)
7. Implement these admin actions and integrate with the UI
8. Create comprehensive E2E tests for the entire admin experience
```

### 5. Setting Up Continuous Integration/Continuous Deployment (CI/CD)

```
Let's set up a CI/CD pipeline for our SvelteKit and Supabase project:

1. Write a test script that runs all unit, integration, and E2E tests
2. Create a GitHub Actions workflow file for running tests on push
3. Implement automatic deployment to Vercel or Netlify for the SvelteKit app
4. Add a step to the CI/CD pipeline to run Supabase migrations
5. Implement preview deployments for pull requests
6. Add performance benchmarking to the CI process
7. Create tests to verify the deployed application is functioning correctly
```

## Best Practices

- Always start development with clear, comprehensive tests
- Use ONE to generate both test cases and implementation code
- Leverage Supabase for backend functionality and real-time features
- Regularly refactor and optimize your code with ONE's assistance
- Utilize TypeScript for enhanced type safety across your project
- Implement proper error handling and logging throughout your application

## Advanced Features

- Full-stack code analysis for SvelteKit and Supabase projects
- Automated security audits for Supabase setup
- Performance optimization recommendations for SvelteKit apps
- Accessibility compliance checks
- Custom code snippet generation for common SvelteKit and Supabase patterns

## Resources

- [Official Website](https://one.ie)
- [Full Documentation](https://one.ie/docs)
- [GitHub Repository](https://github.com/one-ie/vsone)
- [Issue Tracker](https://github.com/one-ie/vsone/issues)
- [Community Discord](https://discord.gg/one-iw)

## Contributing

We welcome contributions! Check out our [Contribution Guidelines](https://github.com/one-ie/vsone/blob/main/CONTRIBUTING.md) to get started.

## License

ONE is open-source software licensed under the [MIT license](https://opensource.org/licenses/MIT). You are free to use, modify, and redistribute the code, including for commercial purposes.

## Support

For support, please email ai@one.ie or join our [Discord community](https://discord.gg/one-ie).

