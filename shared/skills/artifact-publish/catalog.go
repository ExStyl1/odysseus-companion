package artifactpublish

import (
	"embed"
	"fmt"
	"sort"
	"strings"
)

//go:embed skilldata
var skillData embed.FS

type Skill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	files       []string
}

const (
	coreSkillName           = "core"
	designSkillName         = "design"
	datavizSkillName        = "dataviz"
	frontendDesignSkillName = "frontend-design"
)

func catalog() map[string]Skill {
	return map[string]Skill{
		coreSkillName: {
			Name:        "core",
			Description: "The publish and update workflow for t-artifacts.",
			files:       []string{"core.md"},
		},
		designSkillName: {
			Name:        "design",
			Description: "Design guidance for polished artifact content.",
			files:       []string{"design.md"},
		},
		datavizSkillName: {
			Name:        "dataviz",
			Description: "Guidance for charts, dashboards and data visualization.",
			files: []string{
				"dataviz.md",
				"choosing-a-form.md",
				"color-formula.md",
				"marks-and-anatomy.md",
				"interaction.md",
				"components.md",
				"anti-patterns.md",
				"palette.md",
			},
		},
		frontendDesignSkillName: {
			Name:        "frontend-design",
			Description: "Frontend and UI design process for artifact pages.",
			files:       []string{"frontend-design.md", "frontend-design-LICENSE.txt"},
		},
	}
}

func List() []Skill {
	skills := catalog()
	result := make([]Skill, 0, len(skills))
	for _, skill := range skills {
		skill.files = nil
		result = append(result, skill)
	}
	sort.Slice(result, func(left, right int) bool {
		return result[left].Name < result[right].Name
	})
	return result
}

func Get(name string) (content string, found bool, err error) {
	skills := catalog()
	skill, found := skills[name]
	if !found {
		return "", false, nil
	}

	parts := make([]string, 0, len(skill.files))
	for _, file := range skill.files {
		content, err := skillData.ReadFile("skilldata/" + file)
		if err != nil {
			return "", false, fmt.Errorf("read skill file %s: %w", file, err)
		}
		parts = append(parts, strings.TrimSpace(string(content)))
	}

	return strings.Join(parts, "\n\n") + "\n", true, nil
}
