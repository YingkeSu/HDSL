/**
 * TEST-ONLY static-render helper (T006a).
 *
 * Renders `AppView` to an HTML string so renderer tests can assert the state
 * matrix (empty/loading/failed/running/progress/error) without introducing a
 * DOM test dependency into the locked workspace. It is not imported by the
 * production entry (`../index.tsx`).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppView, type AppViewProps } from '../App.js';
import { CreateEnvironmentForm } from '../components/CreateEnvironmentForm.js';
import { DshVersions } from '../components/DshVersions.js';
import { ExpectedComposition } from '../components/ExpectedComposition.js';
import { PluginDiscovery } from '../components/PluginDiscovery.js';
import { PluginInstall } from '../components/PluginInstall.js';
import { PluginRemoval } from '../components/PluginRemoval.js';
import { SwitchVersion } from '../components/SwitchVersion.js';

export const renderAppView = (props: AppViewProps): string =>
  renderToStaticMarkup(createElement(AppView, props));

export const renderCreateForm = (props: AppViewProps): string =>
  renderToStaticMarkup(createElement(CreateEnvironmentForm, props));

export const renderPluginDiscovery = (props: AppViewProps): string =>
  renderToStaticMarkup(createElement(PluginDiscovery, props));

export const renderDshVersions = (props: AppViewProps): string =>
  renderToStaticMarkup(createElement(DshVersions, props));

export const renderExpectedComposition = (props: AppViewProps): string =>
  renderToStaticMarkup(createElement(ExpectedComposition, props));

export const renderPluginInstall = (props: AppViewProps): string =>
  renderToStaticMarkup(createElement(PluginInstall, props));

export const renderPluginRemoval = (props: AppViewProps): string =>
  renderToStaticMarkup(createElement(PluginRemoval, props));

export const renderSwitchVersion = (props: AppViewProps): string =>
  renderToStaticMarkup(createElement(SwitchVersion, props));
