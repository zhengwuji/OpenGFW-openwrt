package geo

import (
	"fmt"
	"net"
	"testing"

	"github.com/apernet/OpenGFW/ruleset/builtins/geo/v2geo"
)

func TestGeoIPMatcherSortsNetworks(t *testing.T) {
	list := &v2geo.GeoIP{Cidr: []*v2geo.CIDR{
		{Ip: []byte{192, 0, 2, 0}, Prefix: 24},
		{Ip: []byte{10, 0, 0, 0}, Prefix: 24},
	}}
	matcher, err := newGeoIPMatcher(list)
	if err != nil {
		t.Fatal(err)
	}
	if got := matcher.N4[0].IP.String(); got != "10.0.0.0" {
		t.Fatalf("first network = %s, want 10.0.0.0", got)
	}
	for _, ip := range []net.IP{net.IPv4(10, 0, 0, 42), net.IPv4(192, 0, 2, 42)} {
		if !matcher.Match(HostInfo{IPv4: ip}) {
			t.Errorf("expected %s to match", ip)
		}
	}
	if matcher.Match(HostInfo{IPv4: net.IPv4(203, 0, 113, 42)}) {
		t.Fatal("unexpected match outside configured networks")
	}
}

func TestGeositeMatcher(t *testing.T) {
	list := &v2geo.GeoSite{
		CountryCode: "TEST",
		Domain: []*v2geo.Domain{
			{Type: v2geo.Domain_Full, Value: "exact.example.com"},
			{Type: v2geo.Domain_RootDomain, Value: "google.com"},
			{Type: v2geo.Domain_RootDomain, Value: "doubleclick.net"},
			{Type: v2geo.Domain_Plain, Value: "keyword"},
			{Type: v2geo.Domain_Regex, Value: `^ad[0-9]+\.com$`},
			{
				Type:  v2geo.Domain_RootDomain,
				Value: "withattr.com",
				Attribute: []*v2geo.Domain_Attribute{
					{Key: "cn"},
				},
			},
		},
	}

	m, err := newGeositeMatcher(list, nil)
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		domain string
		want   bool
	}{
		{"exact.example.com", true},
		{"sub.exact.example.com", false},
		{"google.com", true},
		{"www.google.com", true},
		{"a.b.c.google.com", true},
		{"notgoogle.com", false},
		{"google.com.cn", false},
		{"GOOGLE.COM", true},
		{"GOOGLE.COM.", true},
		{"doubleclick.net", true},
		{"ad.doubleclick.net", true},
		{"testkeywordtest.org", true},
		{"ad123.com", true},
		{"adxyz.com", false},
		{"apple.com", false},
		{"withattr.com", true},
	}

	for _, tc := range cases {
		got := m.Match(HostInfo{Name: tc.domain})
		if got != tc.want {
			t.Errorf("Match(%q) = %v, want %v", tc.domain, got, tc.want)
		}
	}

	// Test attribute filtering
	mAttr, err := newGeositeMatcher(list, []string{"cn"})
	if err != nil {
		t.Fatal(err)
	}
	if !mAttr.Match(HostInfo{Name: "withattr.com"}) {
		t.Errorf("expected withattr.com to match @cn")
	}
	if mAttr.Match(HostInfo{Name: "google.com"}) {
		t.Errorf("expected google.com not to match @cn")
	}
}

func BenchmarkGeositeMatcher100k(b *testing.B) {
	domains := make([]*v2geo.Domain, 100000)
	for i := 0; i < 100000; i++ {
		domains[i] = &v2geo.Domain{
			Type:  v2geo.Domain_RootDomain,
			Value: fmt.Sprintf("ad-domain-%d.com", i),
		}
	}
	list := &v2geo.GeoSite{
		CountryCode: "BENCH",
		Domain:      domains,
	}
	m, err := newGeositeMatcher(list, nil)
	if err != nil {
		b.Fatal(err)
	}

	testHosts := []HostInfo{
		{Name: "ad-domain-50000.com"},
		{Name: "sub.ad-domain-99999.com"},
		{Name: "apple.com"},
		{Name: "nonexistent.example.org"},
	}

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		h := testHosts[i%len(testHosts)]
		_ = m.Match(h)
	}
}
