import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, GripVertical, Plus } from "lucide-react";
import {
  DndContext,
  MouseSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTranslation } from "@/i18n";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { queryKeys } from "../lib/queryKeys";
import { cn, projectRouteRef } from "../lib/utils";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import { SidebarSection, type SidebarSectionRadioChoice } from "./SidebarSection";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import {
  getProjectSortModeStorageKey,
  PROJECT_SORT_MODE_UPDATED_EVENT,
  readProjectSortMode,
  type ProjectSortModeUpdatedDetail,
  type ProjectSidebarSortMode,
  writeProjectSortMode,
} from "../lib/project-order";
import type { Project } from "@paperclipai/shared";

type ProjectSidebarSlot = ReturnType<typeof usePluginSlots>["slots"][number];

const PROJECT_SORT_CHOICES: SidebarSectionRadioChoice[] = [
  { value: "top", label: "Top" },
  { value: "alphabetical", label: "Alphabetical" },
  { value: "recent", label: "Recent" },
];

type ProjectItemProps = {
  activeProjectRef: string | null;
  companyId: string | null;
  companyPrefix: string | null;
  isMobile: boolean;
  project: Project;
  projectSidebarSlots: ProjectSidebarSlot[];
  setSidebarOpen: (open: boolean) => void;
  isDragging?: boolean;
  /** fork_mangoclaw: drag end 직후 click 차단 (예: 250ms 이내) */
  isClickSuppressed?: () => boolean;
  /** fork_mangoclaw: dnd-kit drag handle 의 listeners + attributes */
  dragHandleProps?: React.HTMLAttributes<HTMLElement>;
};

function projectTimestamp(project: Project): number {
  const updated = new Date(project.updatedAt).getTime();
  if (Number.isFinite(updated)) return updated;
  const created = new Date(project.createdAt).getTime();
  return Number.isFinite(created) ? created : 0;
}

function sortProjects(projects: Project[], sortMode: ProjectSidebarSortMode): Project[] {
  if (sortMode === "top") return projects;
  const sorted = [...projects];
  if (sortMode === "alphabetical") {
    sorted.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    return sorted;
  }
  sorted.sort((left, right) => {
    const timeDiff = projectTimestamp(right) - projectTimestamp(left);
    return timeDiff !== 0 ? timeDiff : left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
  return sorted;
}

function ProjectItem({
  activeProjectRef,
  companyId,
  companyPrefix,
  isMobile,
  project,
  projectSidebarSlots,
  setSidebarOpen,
  isDragging = false,
  isClickSuppressed,
  dragHandleProps,
}: ProjectItemProps) {
  const routeRef = projectRouteRef(project);

  return (
    <div className="group/project flex flex-col gap-0.5">
      <div className="relative flex items-center">
        {/* fork_mangoclaw: drag handle — listeners 는 이 grip icon 에만 박힘.
            NavLink 영역은 click navigation 그대로 유지 → 충돌 X.
            평소엔 거의 안 보이고 hover 시 visible. */}
        {dragHandleProps && (
          <span
            {...dragHandleProps}
            className="absolute left-0 z-10 flex h-full w-3 cursor-grab items-center justify-center text-muted-foreground/0 transition-colors hover:bg-accent/30 group-hover/project:text-muted-foreground/50 active:cursor-grabbing"
            aria-label="Drag to reorder"
            title="Drag to reorder"
          >
            <GripVertical className="h-3 w-3" />
          </span>
        )}
        <NavLink
          to={`/projects/${routeRef}/issues`}
          state={SIDEBAR_SCROLL_RESET_STATE}
          onClick={(e) => {
            // fork_mangoclaw: drag 중 또는 drag 직후 250ms 이내 NavLink click 무시 (safety net)
            if (isDragging || isClickSuppressed?.()) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            if (isMobile) setSidebarOpen(false);
          }}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors",
            activeProjectRef === routeRef || activeProjectRef === project.id
              ? "bg-accent text-foreground"
              : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <span
            className="shrink-0 h-3.5 w-3.5 rounded-sm"
            style={{ backgroundColor: project.color ?? "#6366f1" }}
          />
          {/* fork_mangoclaw: prefix identifier (e.g. "MK-01") in sidebar list. */}
          <span className="flex-1 truncate">
            {project.identifier && (
              <span className="font-mono text-xs text-muted-foreground mr-1.5">{project.identifier}</span>
            )}
            {project.name}
          </span>
          {project.pauseReason === "budget" ? <BudgetSidebarMarker title="Project paused by budget" /> : null}
        </NavLink>
      </div>
      {projectSidebarSlots.length > 0 && (
        <div className="ml-5 flex flex-col gap-0.5">
          {projectSidebarSlots.map((slot) => (
            <PluginSlotMount
              key={`${project.id}:${slot.pluginKey}:${slot.id}`}
              slot={slot}
              context={{
                companyId,
                companyPrefix,
                projectId: project.id,
                projectRef: routeRef,
                entityId: project.id,
                entityType: "project",
              }}
              missingBehavior="placeholder"
            />
          ))}
        </div>
      )}
    </div>
  );
}

// fork_mangoclaw: ProjectItem 을 dnd-kit useSortable 로 감싼 래퍼.
// "top" sortMode 일 때만 사용. listeners 는 ProjectItem 의 GripVertical 핸들에만 박힘 — NavLink click 과 분리.
function SortableProjectItem(props: ProjectItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.project.id });

  // listeners + attributes 를 drag handle 로 전달. outer div 는 transform 만.
  const dragHandleProps = { ...attributes, ...listeners } as React.HTMLAttributes<HTMLElement>;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
      }}
      className={cn(isDragging && "opacity-80")}
    >
      <ProjectItem {...props} isDragging={isDragging} dragHandleProps={dragHandleProps} />
    </div>
  );
}

export function SidebarProjects() {
  const [open, setOpen] = useState(true);
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { openNewProject } = useDialogActions();
  const { isMobile, setSidebarOpen } = useSidebar();
  const location = useLocation();
  const { t } = useTranslation();

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { slots: projectSidebarSlots } = usePluginSlots({
    slotTypes: ["projectSidebarItem"],
    entityType: "project",
    companyId: selectedCompanyId,
    enabled: !!selectedCompanyId,
  });

  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const sortModeStorageKey = useMemo(() => {
    if (!selectedCompanyId) return null;
    return getProjectSortModeStorageKey(selectedCompanyId, currentUserId);
  }, [currentUserId, selectedCompanyId]);
  const [sortMode, setSortMode] = useState<ProjectSidebarSortMode>(() => {
    if (!sortModeStorageKey) return "top";
    return readProjectSortMode(sortModeStorageKey);
  });

  const visibleProjects = useMemo(
    () => (projects ?? []).filter((project: Project) => !project.archivedAt),
    [projects],
  );
  const { orderedProjects, persistOrder } = useProjectOrder({
    projects: visibleProjects,
    companyId: selectedCompanyId,
    userId: currentUserId,
  });
  const sortedProjects = useMemo(
    () => sortProjects(orderedProjects, sortMode),
    [orderedProjects, sortMode],
  );
  const isTopMode = sortMode === "top";

  const projectMatch = location.pathname.match(/^\/(?:[^/]+\/)?projects\/([^/]+)/);
  const activeProjectRef = projectMatch?.[1] ?? null;

  // fork_mangoclaw: drag end 후 click event (NavLink navigation 유발) 차단용 ref.
  // useRef 사용 — state 와 달리 re-render 안 일으키고 즉시 읽기 가능.
  const dragEndRef = useRef(0);
  const isClickSuppressed = useCallback(() => {
    return Date.now() - dragEndRef.current < 250;
  }, []);

  const sensors = useSensors(
    // Project reordering is intentionally desktop-only; touch should remain tap/scroll behavior.
    useSensor(MouseSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  useEffect(() => {
    if (!sortModeStorageKey) {
      setSortMode("top");
      return;
    }
    setSortMode(readProjectSortMode(sortModeStorageKey));
  }, [sortModeStorageKey]);

  useEffect(() => {
    if (!sortModeStorageKey) return;

    const onStorage = (event: StorageEvent) => {
      if (event.key !== sortModeStorageKey) return;
      setSortMode(readProjectSortMode(sortModeStorageKey));
    };
    const onCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<ProjectSortModeUpdatedDetail>).detail;
      if (!detail || detail.storageKey !== sortModeStorageKey) return;
      setSortMode(detail.sortMode);
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(PROJECT_SORT_MODE_UPDATED_EVENT, onCustomEvent);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(PROJECT_SORT_MODE_UPDATED_EVENT, onCustomEvent);
    };
  }, [sortModeStorageKey]);

  const persistSortMode = useCallback(
    (value: string) => {
      const nextSortMode: ProjectSidebarSortMode =
        value === "alphabetical" || value === "recent" ? value : "top";
      setSortMode(nextSortMode);
      if (sortModeStorageKey) {
        writeProjectSortMode(sortModeStorageKey, nextSortMode);
      }
    },
    [sortModeStorageKey],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!isTopMode) return;
      const { active, over } = event;
      if (!over || active.id === over.id) {
        // drop 위치 변화 없어도 click suppress (단순 클릭으로 끝났을 수도)
        dragEndRef.current = Date.now();
        return;
      }

      const ids = orderedProjects.map((project) => project.id);
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      // drag end timestamp — NavLink onClick 에서 250ms 이내 click 차단
      dragEndRef.current = Date.now();
      // setTimeout 으로 defer — dnd-kit cleanup 끝난 후 state 변경
      setTimeout(() => {
        persistOrder(arrayMove(ids, oldIndex, newIndex));
      }, 0);
    },
    [isTopMode, orderedProjects, persistOrder],
  );

  const renderProject = (project: Project) => (
    <ProjectItem
      key={project.id}
      activeProjectRef={activeProjectRef}
      companyId={selectedCompanyId}
      companyPrefix={selectedCompany?.issuePrefix ?? null}
      isMobile={isMobile}
      project={project}
      projectSidebarSlots={projectSidebarSlots}
      setSidebarOpen={setSidebarOpen}
    />
  );

  return (
    <SidebarSection
      label={t("nav.section.projects", { defaultValue: "Projects" })}
      collapsible={{ open, onOpenChange: setOpen }}
      headerAction={{
        ariaLabel: t("nav.newProject", { defaultValue: "New project" }) as string,
        icon: Plus,
        onClick: openNewProject,
      }}
      menu={{
        ariaLabel: "Projects section actions",
        actions: [
          { type: "item", label: t("nav.browseProjects", { defaultValue: "Browse projects" }) as string, icon: FolderOpen, href: "/projects" },
          { type: "separator" },
        ],
        radioLabel: "Project sort",
        radioChoices: PROJECT_SORT_CHOICES,
        radioValue: sortMode,
        onRadioValueChange: persistSortMode,
      }}
    >
      {isTopMode ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={orderedProjects.map((project) => project.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flex flex-col gap-0.5">
              {orderedProjects.map((project: Project) => (
                <SortableProjectItem
                  key={project.id}
                  activeProjectRef={activeProjectRef}
                  companyId={selectedCompanyId}
                  companyPrefix={selectedCompany?.issuePrefix ?? null}
                  isMobile={isMobile}
                  project={project}
                  projectSidebarSlots={projectSidebarSlots}
                  setSidebarOpen={setSidebarOpen}
                  isClickSuppressed={isClickSuppressed}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="flex flex-col gap-0.5">
          {sortedProjects.map((project: Project) => renderProject(project))}
        </div>
      )}
    </SidebarSection>
  );
}
