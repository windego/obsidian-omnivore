import { DateTime } from "luxon";
import Mustache from "mustache";
import {
  App,
  normalizePath,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";
import {
  Article,
  compareHighlightsInFile,
  DATE_FORMAT,
  getHighlightLocation,
  loadArticles,
  PageType,
  parseDateTime,
  unicodeSlug,
  getPageName
} from "./util";
import { FolderSuggest } from "./settings/file-suggest";

// Remember to rename these classes and interfaces!
enum Filter {
  ALL = "import all my articles",
  HIGHLIGHTS = "import just highlights",
  ADVANCED = "advanced",
}

enum HighlightOrder {
  LOCATION = "the location of highlights in the article",
  TIME = "the time that highlights are updated",
}

interface Settings {
  apiKey: string;
  filter: string;
  syncAt: string;
  customQuery: string;
  highlightOrder: string;
  template: string;
  syncing: boolean;
  folder: string;
  dateFormat: string;
  endpoint: string;
  // templateFileLocation: string;
}

const DEFAULT_SETTINGS: Settings = {
  apiKey: "6e376c93-f616-4e96-ac16-250c1c9e6bda",
  filter: "HIGHLIGHTS",
  syncAt: "",
  customQuery: "",
  template: `---
文章标题: {{{title}}}
{{#author}}
文章作者: {{{author}}}
{{/author}}
保存时间: {{{dateSaved}}}
---
{{#labels.length}}
{{#labels}}#{{{name}}} {{/labels}}
{{/labels.length}}

#Omnivore
[使用Omnivore打开]({{{omnivoreUrl}}})
[打开原文]({{{originalUrl}}})
{{#content}}

{{{content}}}
{{/content}}

{{#highlights.length}}
## Highlights

{{#highlights}}
> {{{text}}} [⤴️]({{{highlightUrl}}})
{{#note}}

{{{note}}}
{{/note}}

{{/highlights}}
{{/highlights.length}}`,
  highlightOrder: "LOCATION",
  syncing: false,
  folder: "Omnivore",
  dateFormat: "yyyy-MM-dd",
  endpoint: "https://api-prod.omnivore.app/api/graphql",
  // templateFileLocation: "",
};

export default class OmnivorePlugin extends Plugin {
  settings: Settings;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "omnivore-sync",
      name: "Sync",
      callback: () => {
        this.fetchOmnivore();
      },
    });

    this.addCommand({
      id: "omnivore-resync",
      name: "Resync all articles",
      callback: () => {
        this.settings.syncAt = "";
        this.saveSettings();
        new Notice("Omnivore Last Sync reset");
        this.fetchOmnivore();
      },
    });

    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(new OmnivoreSettingTab(this.app, this));
    setTimeout(() => {
      this.fetchOmnivore();
    }, 500);
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async fetchOmnivore() {
    const {
      syncAt,
      apiKey,
      filter,
      customQuery,
      highlightOrder,
      syncing,
      template,
      folder,
    } = this.settings;

    if (syncing) return;

    if (!apiKey) {
      new Notice("Missing Omnivore api key");

      return;
    }

    this.settings.syncing = true;
    await this.saveSettings();

    try {
      console.log(`obsidian-omnivore starting sync since: '${syncAt}`);

      new Notice("🚀 正在同步Omnivore收藏的文章 ...");

      const size = 50;
      for (
        let hasNextPage = true, articles: Article[] = [], after = 0;
        hasNextPage;
        after += size
      ) {
        [articles, hasNextPage] = await loadArticles(
          this.settings.endpoint,
          apiKey,
          after,
          size,
          parseDateTime(syncAt).toISO(),
          this.getQueryFromFilter(filter, customQuery),
          true,
          "markdown"
        );

        for (const article of articles) {
          const dateSaved = DateTime.fromISO(article.savedAt).toFormat(
            this.settings.dateFormat
          );
          const folderName = `${folder}/${dateSaved}`;
          if (
            !(await this.app.vault.adapter.exists(normalizePath(folderName)))
          ) {
            await this.app.vault.createFolder(folderName);
          }

          // use unicode slug to show characters from other languages in the file name
          // const pageName = `${folderName}/${unicodeSlug(
          //   article.title,
          //   article.savedAt
          // )}.md`;
          const pageName = `${folderName}/${article.title}.md`;
          const siteName =
            article.siteName ||
            this.siteNameFromUrl(article.originalArticleUrl);

          // sort highlights by location if selected in options
          highlightOrder === "LOCATION" &&
            article.highlights?.sort((a, b) => {
              try {
                if (article.pageType === PageType.File) {
                  // sort by location in file
                  return compareHighlightsInFile(a, b);
                }
                // for web page, sort by location in the page
                return (
                  getHighlightLocation(a.patch) - getHighlightLocation(b.patch)
                );
              } catch (e) {
                console.error(e);
                return compareHighlightsInFile(a, b);
              }
            });

          const highlights = article.highlights?.map((highlight) => {
            return {
              text: highlight.quote,
              highlightUrl: `https://omnivore.app/me/${article.slug}#${highlight.id}`,
              dateHighlighted: DateTime.fromISO(highlight.updatedAt).toFormat(
                this.settings.dateFormat
              ),
              note: highlight.annotation,
            };
          });

          // // use template from file if specified
          // let templateToUse = template;
          // if (templateFileLocation) {
          //   const templateFile =
          //     this.app.vault.getAbstractFileByPath(templateFileLocation);
          //   if (templateFile) {
          //     templateToUse = await this.app.vault.read(templateFile as TFile);
          //   }
          // }

          // Build content string based on template
          const content = Mustache.render(template, {
            title: article.title,
            omnivoreUrl: `https://omnivore.app/me/${article.slug}`,
            siteName,
            originalUrl: article.originalArticleUrl,
            author: article.author,
            labels: article.labels?.map((l) => {
              return {
                name: l.name.replace(" ", "_"),
              };
            }),
            dateSaved,
            highlights,
            content: article.content,
          });

          await this.app.vault.adapter.write(normalizePath(pageName), content);
        }
      }

      new Notice("🔖 文章同步完成!");
      this.settings.syncAt = DateTime.local().toFormat(DATE_FORMAT);
    } catch (e) {
      new Notice("omnivore文章同步失败!");
      console.error(e);
    } finally {
      this.settings.syncing = false;
      await this.saveSettings();
    }
  }

  getQueryFromFilter(filter: string, customQuery: string): string {
    switch (filter) {
      case "ALL":
        return "";
      case "HIGHLIGHTS":
        return `has:highlights`;
      case "ADVANCED":
        return customQuery;
      default:
        return "";
    }
  }

  siteNameFromUrl(originalArticleUrl: string): string {
    try {
      return new URL(originalArticleUrl).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }
}

class OmnivoreSettingTab extends PluginSettingTab {
  plugin: OmnivorePlugin;

  constructor(app: App, plugin: OmnivorePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private static createFragmentWithHTML = (html: string) =>
    createFragment(
      (documentFragment) => (documentFragment.createDiv().innerHTML = html)
    );

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl("h2", { text: "Settings for omnivore plugin" });

    // create a group of general settings
    containerEl.createEl("h3", {
      cls: "collapsible",
      text: "General Settings",
    });

    const generalSettings = containerEl.createEl("div", {
      cls: "content",
    });

    new Setting(generalSettings)
      .setName("API Key")
      .setDesc(
        OmnivoreSettingTab.createFragmentWithHTML(
          "You can create an API key at <a href='https://omnivore.app/settings/api'>https://omnivore.app/settings/api</a>"
        )
      )
      .addText((text) =>
        text
          .setPlaceholder("Enter your Omnivore Api Key")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            console.log("apiKey: " + value);
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(generalSettings)
      .setName("Filter")
      .setDesc("Select an Omnivore search filter type")
      .addDropdown((dropdown) => {
        dropdown.addOptions(Filter);
        dropdown
          .setValue(this.plugin.settings.filter)
          .onChange(async (value) => {
            console.log("filter: " + value);
            this.plugin.settings.filter = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(generalSettings)
      .setName("Custom query")
      .setDesc(
        OmnivoreSettingTab.createFragmentWithHTML(
          "See <a href='https://omnivore.app/help/search'>https://omnivore.app/help/search</a> for more info on search query syntax"
        )
      )
      .addText((text) =>
        text
          .setPlaceholder(
            "Enter an Omnivore custom search query if advanced filter is selected"
          )
          .setValue(this.plugin.settings.customQuery)
          .onChange(async (value) => {
            console.log("query: " + value);
            this.plugin.settings.customQuery = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(generalSettings)
      .setName("Last Sync")
      .setDesc("Last time the plugin synced with Omnivore")
      .addMomentFormat((momentFormat) =>
        momentFormat
          .setPlaceholder("Last Sync")
          .setValue(this.plugin.settings.syncAt)
          .setDefaultFormat("yyyy-MM-dd'T'HH:mm:ss")
          .onChange(async (value) => {
            console.log("syncAt: " + value);
            this.plugin.settings.syncAt = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(generalSettings)
      .setName("Highlight Order")
      .setDesc("Select the order in which highlights are applied")
      .addDropdown((dropdown) => {
        dropdown.addOptions(HighlightOrder);
        dropdown
          .setValue(this.plugin.settings.highlightOrder)
          .onChange(async (value) => {
            console.log("highlightOrder: " + value);
            this.plugin.settings.highlightOrder = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(generalSettings)
      .setName("Template")
      .setDesc(
        OmnivoreSettingTab.createFragmentWithHTML(
          `Enter template to render articles with. <a href="https://github.com/janl/mustache.js/#templates">Reference</a>`
        )
      )
      .addTextArea((text) =>
        text
          .setPlaceholder("Enter the template")
          .setValue(this.plugin.settings.template)
          .onChange(async (value) => {
            console.log("template: " + value);
            this.plugin.settings.template = value;
            await this.plugin.saveSettings();
          })
      );

    // new Setting(generalSettings)
    //   .setName("Template file location")
    //   .setDesc("Choose the file to use as the template")
    //   .addSearch((search) => {
    //     new FileSuggest(this.app, search.inputEl);
    //     search
    //       .setPlaceholder("Enter the file path")
    //       .setValue(this.plugin.settings.templateFileLocation)
    //       .onChange(async (value) => {
    //         this.plugin.settings.templateFileLocation = value;
    //         await this.plugin.saveSettings();
    //       });
    //   });

    new Setting(generalSettings)
      .setName("Folder")
      .setDesc("Enter the folder where the data will be stored")
      .addSearch((search) => {
        new FolderSuggest(this.app, search.inputEl);
        search
          .setPlaceholder("Enter the folder")
          .setValue(this.plugin.settings.folder)
          .onChange(async (value) => {
            this.plugin.settings.folder = value;
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", {
      cls: "collapsible",
      text: "Advanced Settings",
    });

    const advancedSettings = containerEl.createEl("div", {
      cls: "content",
    });

    new Setting(generalSettings)
      .setName("Date Format")
      .setDesc(
        OmnivoreSettingTab.createFragmentWithHTML(
          'Enter the format date for use in rendered template.\nFormat <a href="https://moment.github.io/luxon/#/formatting?id=table-of-tokens">reference</a>.'
        )
      )
      .addText((text) =>
        text
          .setPlaceholder("Date Format")
          .setValue(this.plugin.settings.dateFormat)
          .onChange(async (value) => {
            this.plugin.settings.dateFormat = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(advancedSettings)
      .setName("API Endpoint")
      .setDesc("Enter the Omnivore server's API endpoint")
      .addText((text) =>
        text
          .setPlaceholder("API endpoint")
          .setValue(this.plugin.settings.endpoint)
          .onChange(async (value) => {
            console.log("endpoint: " + value);
            this.plugin.settings.endpoint = value;
            await this.plugin.saveSettings();
          })
      );

    const help = containerEl.createEl("p");
    help.innerHTML = `For more information, please visit the <a href="https://github.com/omnivore-app/obsidian-omnivore/blob/master/README.md">plugin's GitHub page</a> or email us at <a href="mailto:feedback@omnivore.app">feedback@omnivore.app</a>.`;

    // script to make collapsible sections
    const coll = document.getElementsByClassName("collapsible");
    let i;

    for (i = 0; i < coll.length; i++) {
      coll[i].addEventListener("click", function () {
        this.classList.toggle("active");
        const content = this.nextElementSibling;
        if (content.style.maxHeight) {
          content.style.maxHeight = null;
        } else {
          content.style.maxHeight = "fit-content";
        }
      });
    }
  }
}
