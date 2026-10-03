import { defineConfig } from 'wxt';

export default defineConfig({
  outDir: 'dist',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Saysheet',
    description:
      'Export comments and replies from Facebook or LinkedIn posts into organized Excel workbooks.',
    version: '1.1.2',
    permissions: ['activeTab', 'scripting', 'storage', 'downloads'],
    optional_host_permissions: [
      'https://facebook.com/*',
      'https://*.facebook.com/*',
      'https://linkedin.com/*',
      'https://*.linkedin.com/*',
    ],
    action: {
      default_title: 'Export post comments',
    },
  },
});
