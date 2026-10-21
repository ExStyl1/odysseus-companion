package artifactpublish_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	artifactpublish "gitlab.tcsbank.ru/loyalty-personalization/t-artifacts/skills/artifact-publish"
)

func TestList(t *testing.T) {
	t.Parallel()

	list := artifactpublish.List()
	require.Equal(t, []string{"core", "dataviz", "design", "frontend-design"}, []string{
		list[0].Name,
		list[1].Name,
		list[2].Name,
		list[3].Name,
	})
}

func TestGet(t *testing.T) {
	t.Parallel()

	content, found, err := artifactpublish.Get("dataviz")
	require.NoError(t, err)
	require.True(t, found)
	require.Contains(t, content, "Data Visualization")
	require.Contains(t, content, "Color")
}

func TestGetUnknown(t *testing.T) {
	t.Parallel()

	content, found, err := artifactpublish.Get("unknown")
	require.NoError(t, err)
	require.False(t, found)
	require.Empty(t, content)
}
