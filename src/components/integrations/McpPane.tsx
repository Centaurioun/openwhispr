import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { CopyableCommand } from "../ui/CopyableCommand";
import { SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";
import { useToast } from "../ui/useToast";
import { IntegrationsPane, UpsellBar } from "./IntegrationsPane";
import claudeIcon from "../../assets/icons/providers/claude.svg";
import openaiIcon from "../../assets/icons/providers/openai.svg";
import cursorIcon from "../../assets/icons/providers/cursor.svg";

const MCP_URL = "https://mcp.openwhispr.com/mcp";
const MCP_DOCS_URL = "https://docs.openwhispr.com/integrations/mcp";
const LOCAL_BUILD_COMMAND =
  "npm install -g @openwhispr/cli@0.3.0 && npm --prefix tools/local-mcp install && npm --prefix tools/local-mcp run build";
const LOCAL_ADD_COMMAND =
  'codex mcp add openwhispr-local -- node "$PWD/tools/local-mcp/dist/server.js"';
const LOCAL_STATUS_COMMAND = "codex mcp get openwhispr-local";
const LOCAL_MCP_SETUP_URL =
  "https://github.com/Centaurioun/openwhispr/blob/codex/local-mcp-2026-10-30/docs/custom/local-mcp-setup.md";

const MCP_CLIENTS = [
  { name: "Claude", icon: claudeIcon },
  { name: "ChatGPT", icon: openaiIcon },
  { name: "Cursor", icon: cursorIcon },
];

interface McpPaneProps {
  title: string;
  isPaid: boolean;
  onUpgrade: () => void;
  onCreateKey: () => void;
}

export function McpPane({ title, isPaid, onUpgrade, onCreateKey }: McpPaneProps): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();

  return (
    <IntegrationsPane
      title={title}
      description={t("integrations.mcp.description")}
      docsUrl={MCP_DOCS_URL}
    >
      <SettingsPanel>
        <SettingsPanelRow className="space-y-3">
          <div className="flex h-[18px] items-center gap-1.5">
            <h3 className="text-xs font-semibold text-foreground">
              {t("integrations.mcp.local.title")}
            </h3>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
              {t("integrations.mcp.local.freeBadge")}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            {t("integrations.mcp.local.description")}
          </p>
          <p className="text-xs text-muted-foreground/80 leading-relaxed">
            {t("integrations.mcp.local.privacy")}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="-ms-2 w-fit text-muted-foreground"
            onClick={() => window.electronAPI?.openExternal?.(LOCAL_MCP_SETUP_URL)}
          >
            {t("integrations.mcp.local.setupGuideLabel")}
          </Button>
          <div>
            <p className="text-xs leading-5 font-medium text-foreground mb-2">
              {t("integrations.mcp.local.setup")}
            </p>
            <CopyableCommand
              command={LOCAL_BUILD_COMMAND}
              label={t("integrations.mcp.local.buildCommandLabel")}
            />
            <div className="mt-3">
              <CopyableCommand
                command={LOCAL_ADD_COMMAND}
                label={t("integrations.mcp.local.addToCodexLabel")}
                copyLabel={t("integrations.mcp.local.copyCommand")}
              />
            </div>
          </div>
          <div className="border-t border-border pt-3">
            <p className="text-xs font-medium text-foreground mb-2">
              {t("integrations.mcp.local.statusLabel")}
            </p>
            <p className="text-xs text-muted-foreground mb-2 leading-relaxed">
              {t("integrations.mcp.local.statusDescription")}
            </p>
            <CopyableCommand
              command={LOCAL_STATUS_COMMAND}
              label={t("integrations.mcp.local.verifyCommandLabel")}
            />
          </div>
        </SettingsPanelRow>
      </SettingsPanel>

      <SettingsPanel>
        <SettingsPanelRow className="space-y-2.5">
          <div>
            <div className="flex h-[18px] items-center gap-1.5">
              <h3 className="text-xs font-semibold text-foreground">
                {t("integrations.mcp.hosted.title")}
              </h3>
              {!isPaid && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
                  {t("integrations.plan.pro")}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed">
              {t("integrations.mcp.worksWith")}{" "}
              {MCP_CLIENTS.map((client) => (
                <span key={client.name} className="inline-flex items-center gap-1 ms-1">
                  <img
                    src={client.icon}
                    alt=""
                    aria-hidden="true"
                    width={14}
                    height={14}
                    decoding="async"
                    draggable={false}
                    className="h-3.5 w-3.5 icon-monochrome"
                  />
                  {client.name}
                </span>
              ))}
            </p>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              {t("integrations.mcp.hosted.description")}
            </p>
          </div>
          {!isPaid && (
            <UpsellBar message={t("integrations.mcp.proRequired")} onUpgrade={onUpgrade} />
          )}
          <p className="text-xs leading-5 font-medium text-foreground mb-2">
            {t("integrations.mcp.step1")}
          </p>
          <CopyableCommand
            command={MCP_URL}
            copyLabel={t("integrations.mcp.copyUrl")}
            onCopied={() =>
              toast({
                title: t("integrations.mcp.copied"),
                variant: "success",
                duration: 2000,
              })
            }
          />
          <div className="border-t border-border pt-3">
            <h3 className="text-xs font-semibold text-foreground">
              {t("integrations.mcp.oauthTitle")}
            </h3>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              {t("integrations.mcp.oauthDescription")}
            </p>
          </div>
          <div className="border-t border-border pt-3">
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex-1 basis-60 min-w-0">
                <h3 className="text-xs font-semibold text-foreground">
                  {t("integrations.mcp.apiKeyTitle")}
                </h3>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  {t("integrations.mcp.apiKeyDescription")}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={onCreateKey}
                disabled={!isPaid}
                className="shrink-0"
              >
                {t("apiKeysSection.createButton")}
              </Button>
            </div>
            <code dir="ltr" className="block text-xs text-foreground mt-2 break-all select-all">
              Authorization: Bearer YOUR_API_KEY
            </code>
          </div>
        </SettingsPanelRow>
      </SettingsPanel>
    </IntegrationsPane>
  );
}
